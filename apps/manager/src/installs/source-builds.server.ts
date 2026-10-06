import {
  type ArtifactManifest,
  artifactManifestSchema,
  type BuildCommandChoice,
  buildCleanupRequestSchema,
  buildCommandChoiceSchema,
  type CatalogManifest,
  type CatalogSecret,
  catalogWorkerName,
  githubRepositorySchema,
  gitRefSchema,
  type IndexApp,
  parseRepositoryInput,
  type RepositoryDetection,
  repositoryDetectionSchema,
  repositoryUrl,
  type SandboxInfo,
  sandboxObjectUrl,
  secretValueProblem,
} from "@appflare/schema";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { type AccessPreflightProblem, accessInstallRefusal } from "../access/preflight.server";
import type { AccountPlan } from "../account/plan";
import { readAccountPlan, writeAccountPlan } from "../account/plan.server";
import { parseStoredCapabilities } from "../capabilities/capabilities";
import { analyticsEngineRefusal } from "../catalog/requirement-checks";
import { appKey, installAppKey, parseAppKey } from "../catalog/sources";
import { createDb } from "../db/client";
import { type InstallOrigin, installs, jobs, resources, source_builds } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import type { UsedGithubToken } from "../github/access.server";
import type { InstallJobParams } from "../jobs/install";
import type { PrebuiltBuildParams } from "../jobs/install/artifact-source";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import { parseStoredVars } from "../jobs/reconfigure/plan";
import { NO_ACTIVE_SELF_UPDATE_SQL, refuseDuringSelfUpdate } from "../jobs/self-update/guard";
import { type SourceBuildJobParams, sourceBuildRunId } from "../jobs/source-build";
import type { UpdateJobParams } from "../jobs/update";
import {
  lastDurableObjectTagOf,
  missingSecrets,
  updatePath,
  workerExportsOf,
} from "../jobs/update/plan";
import {
  afterRefusedClaim,
  launchSandboxEnable,
  planSandboxFirst,
  type SandboxAutoEnableDeps,
  SandboxAutoEnableError,
  type SandboxFirst,
  sandboxEnableClaim,
  sandboxFirstGuardSql,
} from "../sandbox/auto-enable.server";
import { buildsFromRepository, sandboxBinding } from "../sandbox/binding";
import { ENABLE_SANDBOX_PLACE, UPDATE_SANDBOX_HINT } from "../sandbox/connect-copy";
import {
  derivedVarValues,
  heldSecrets,
  secretsToAskFor,
  sourcesOfUnsetDerivedVars,
  withDerivedSecrets,
} from "./derived-secrets";
import { GitRefError, type RemoteRefs, resolveRef } from "./git-refs";
import type { InstallDomainInput, StartInstallInput } from "./install-input";
import { UNUSED_BUILD_MS } from "./source-builds-retention";
import { repositoryAppSlug, reviewBuild } from "./source-review";
import { resolveInstallInput, seedParams, withDerivedValues } from "./start-install.server";
import {
  claim,
  readInstall,
  type StartJobDeps,
  statusRefusal,
  VersionActionError,
} from "./versions.server";

/**
 * Building from a repository, and from source: starting the build, reading
 * it back for the review, then installing or updating from it, or throwing
 * it away; and "Check for changes" for installs that came from a repository.
 *
 * A build is a `source_build` job plus its `source_builds` row. The admin
 * reviews what the build declares (bindings, resources, secrets, settings,
 * requirements, and why it would be refused) before anything is deployed;
 * installing or updating starts the ordinary install or update job with the
 * reviewed build as its artifact. Builds run in the sandbox Worker, which is
 * Workers Paid only, so all of this is refused unless sandbox builds are on
 * and the account is on Workers Paid.
 */

export class SourceBuildError extends Error {
  override name = "SourceBuildError";
}

/** What decides whether builds from a repository can start. */
export interface SourceBuildGate {
  /** The manager has its `SANDBOX` binding. */
  connected: boolean;
  plan: AccountPlan;
  /** The sandbox Worker's `info()`; null when it did not answer (or was not asked). */
  info: SandboxInfo | null;
}

/** Why a build from a repository cannot start now, or null when it can. */
export function sourceBuildRefusal(gate: SourceBuildGate): string | null {
  if (gate.plan !== "paid") {
    return "Building from a repository runs in a container, which needs the Workers Paid plan on this account.";
  }
  if (!gate.connected) {
    return `Sandbox builds are off. Enable them in ${ENABLE_SANDBOX_PLACE} first.`;
  }
  if (gate.info === null) return "The sandbox Worker did not answer. Try again in a minute.";
  if (!buildsFromRepository(gate.info)) {
    return `The sandbox Worker ${gate.info.sandboxVersion} cannot build from a repository yet: to update it, ${UPDATE_SANDBOX_HINT}.`;
  }
  return null;
}

export type StartSourceBuildRequest =
  | {
      kind: "repository";
      /** What the admin typed: a GitHub URL or `owner/repo`. */
      repository: string;
      /** A branch, tag or commit; empty for the URL's, else the default branch. */
      ref?: string;
      buildCommand?: BuildCommandChoice;
      costConfirmed: boolean;
    }
  | {
      kind: "source";
      /** The catalog app. */
      slug: string;
      ref?: string;
      buildCommand?: BuildCommandChoice;
      costConfirmed: boolean;
    }
  | { kind: "rebuild"; installId: string; costConfirmed: boolean };

/**
 * A repository's branches and tags, and the GitHub access token that read
 * them (none for a public repository).
 */
export type ReadRefs = RemoteRefs & { token?: UsedGithubToken | null };

export interface SourceBuildDeps {
  db: D1Database;
  workflows?: WorkflowLookup;
  createJob(id: string, params: SourceBuildJobParams): Promise<{ id: string }>;
  /** Whether the manager has its `SANDBOX` binding, and the sandbox Worker's `info()`. */
  sandbox(): Promise<{ connected: boolean; info: SandboxInfo | null }>;
  /**
   * Turning sandbox builds on first when they are off. Without it a build is
   * refused until they are enabled in Settings.
   */
  autoEnable?: SandboxAutoEnableDeps;
  /** The branches and tags of a repository (`git ls-remote`); throws `GitRefError`. */
  listRefs(repo: string): Promise<ReadRefs>;
  /** A catalog app and its verified catalog manifest; throws `SourceBuildError` when unavailable. */
  loadCatalogApp(slug: string): Promise<{ app: IndexApp; catalog: CatalogManifest }>;
  now?: () => Date;
  newId?: () => string;
}

/**
 * SQL condition: no job enables, updates or disables the sandbox Worker now
 * (each replaces it, and with it every container a build would run in),
 * other than the enable job bound to ?11, which the build waits for.
 */
const SANDBOX_WORKER_JOBS_SQL = `NOT EXISTS (SELECT 1 FROM jobs WHERE kind IN ('sandbox_enable', 'sandbox_update', 'sandbox_disable') AND status IN ('queued', 'running') AND id IS NOT ?11)`;

/** `owner/repo` of a recorded `https://github.com/owner/repo`, or null. */
export function repoOfUrl(url: string | null): string | null {
  if (url === null) return null;
  const repo = url.replace(/^https:\/\/github\.com\//, "");
  return repo !== url && githubRepositorySchema.safeParse(repo).success ? repo : null;
}

/** The build command choice the install's last used build made, else detection. */
async function lastBuildCommand(db: D1Database, installId: string): Promise<BuildCommandChoice> {
  const [row] = await createDb(db)
    .select({ json: source_builds.build_command_json })
    .from(source_builds)
    .where(and(eq(source_builds.install_id, installId), eq(source_builds.status, "used")))
    .orderBy(desc(source_builds.id))
    .limit(1);
  if (row?.json == null) return { mode: "detect" };
  try {
    const parsed = buildCommandChoiceSchema.safeParse(JSON.parse(row.json));
    return parsed.success ? parsed.data : { mode: "detect" };
  } catch {
    return { mode: "detect" };
  }
}

/**
 * Versions an install's builds use now: its own and its snapshots', newest
 * snapshot first. A rollback itself deploys the snapshot's Worker version and
 * reads no file, but it makes the snapshot's artifact the install's again,
 * which a later reconfigure reads (`jobs/reconfigure.ts`), and any snapshot
 * can be rolled back to. `limit` caps the snapshots read, for a list with a
 * size limit of its own; deleting files never passes one, so no version a
 * rollback can reach is left off.
 */
async function versionsInUse(
  db: D1Database,
  installId: string,
  current: string,
  limit?: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT catalog_version AS version FROM snapshots
       WHERE install_id = ?1 AND catalog_version IS NOT NULL AND catalog_version != ''
       GROUP BY catalog_version
       ORDER BY max(taken_at) DESC, catalog_version
       LIMIT ?2`,
    )
    .bind(installId, limit ?? -1)
    .all<{ version: string }>();
  return [...new Set([current, ...results.map((r) => r.version)])];
}

interface BuildPlan {
  installId: string;
  purpose: "install" | "update";
  origin: Exclude<InstallOrigin, "catalog">;
  appSlug: string | null;
  repo: string;
  ref: string | null;
  buildCommand: BuildCommandChoice;
  baseline?: CatalogManifest;
  avoidVersions: string[];
}

async function planBuild(
  deps: SourceBuildDeps,
  request: StartSourceBuildRequest,
  newId: () => string,
): Promise<BuildPlan> {
  const fail = (message: string) => new SourceBuildError(message);
  const refOf = (text: string | undefined, fallback: string | null): string | null => {
    const ref = text?.trim() ?? "";
    if (ref.length === 0) return fallback;
    if (!gitRefSchema.safeParse(ref).success) {
      throw fail(`"${ref}" is not a branch, tag or commit Appflare can build.`);
    }
    return ref;
  };
  if (request.kind === "repository") {
    const parsed = parseRepositoryInput(request.repository);
    if (!parsed.ok) throw fail(parsed.error);
    return {
      installId: newId(),
      purpose: "install",
      origin: "repository",
      appSlug: null,
      repo: parsed.repo,
      ref: refOf(request.ref, parsed.ref),
      buildCommand: request.buildCommand ?? { mode: "detect" },
      avoidVersions: [],
    };
  }
  if (request.kind === "source") {
    const { app, catalog } = await deps.loadCatalogApp(request.slug);
    if (app.tier === "self-deploying") {
      throw fail(
        `${app.name} deploys itself with its own installer, so it cannot be built from source.`,
      );
    }
    if (!githubRepositorySchema.safeParse(catalog.repo).success) {
      throw fail(`${app.name}'s repository (${catalog.repo}) is not one Appflare can build.`);
    }
    return {
      installId: newId(),
      purpose: "install",
      origin: "source",
      // The app key, so the install from this build records its catalog too.
      appSlug: appKey(parseAppKey(request.slug).catalogId, app.slug),
      repo: catalog.repo,
      ref: refOf(request.ref, null),
      buildCommand: request.buildCommand ?? { mode: "detect" },
      baseline: catalog,
      avoidVersions: [],
    };
  }
  const install = await readInstall(deps.db, request.installId).catch((error: unknown) => {
    throw fail(error instanceof Error ? error.message : String(error));
  });
  const refusal = statusRefusal(install.status);
  if (refusal !== null) throw fail(refusal);
  if (install.origin === "catalog") {
    throw fail("This app comes from the catalog; it is updated from the catalog.");
  }
  const repo = repoOfUrl(install.source_url);
  if (repo === null) throw fail("This install does not record the repository it came from.");
  let baseline: CatalogManifest | undefined;
  if (install.origin === "source") {
    try {
      baseline = (await deps.loadCatalogApp(installAppKey(install))).catalog;
    } catch {
      // The app left the catalog: build with the catalog manifest it was installed with.
      baseline = installedCatalog(install.manifest_json) ?? undefined;
    }
    if (baseline === undefined) throw fail("The catalog manifest of this app is not available.");
  }
  return {
    installId: install.id,
    purpose: "update",
    origin: install.origin,
    appSlug: install.origin === "source" ? installAppKey(install) : null,
    repo,
    ref: install.source_ref,
    buildCommand: await lastBuildCommand(deps.db, install.id),
    ...(baseline === undefined ? {} : { baseline }),
    // The build request takes at most 16: the newest snapshots'.
    avoidVersions: await versionsInUse(deps.db, install.id, install.catalog_version, 15),
  };
}

/** The catalog manifest an install was made with (from its artifact manifest), or null. */
export function installedCatalog(manifestJson: string | null): CatalogManifest | null {
  return parseManifest(manifestJson)?.catalog ?? null;
}

function parseManifest(text: string | null): ArtifactManifest | null {
  if (text === null) return null;
  try {
    const parsed = artifactManifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Starts a build for review: of a repository an admin named, of a catalog
 * app from source at another commit, or of an install that came from a
 * repository, at its branch's newest commit ("Rebuild and update"). The
 * ref is resolved first (so a missing branch, or a private repository no
 * GitHub access token can read, is refused before a container starts), and
 * the build is pinned to that commit, cloned with the token that read it.
 */
export async function startSourceBuildCore(
  deps: SourceBuildDeps,
  request: StartSourceBuildRequest,
): Promise<{ jobId: string }> {
  const fail = (message: string) => new SourceBuildError(message);
  await refuseDuringSelfUpdate(deps.db, deps.workflows, fail);
  const orm = createDb(deps.db);
  const sandbox = await deps.sandbox();
  const accountPlan = await readAccountPlan(orm);
  // Off: turned on first by a job of its own when the account allows it
  // (live checks below, once the request itself is known to be buildable).
  const turnOnFirst = !sandbox.connected && deps.autoEnable !== undefined;
  const refusal = turnOnFirst ? null : sourceBuildRefusal({ ...sandbox, plan: accountPlan });
  if (refusal !== null) throw fail(refusal);
  if (!request.costConfirmed) {
    throw fail("The build runs in your sandbox Worker on Workers Paid. Confirm its cost.");
  }
  const newId = deps.newId ?? (() => ulid());
  const plan = await planBuild(deps, request, newId);

  let resolved: ReturnType<typeof resolveRef>;
  /** The GitHub access token that read a private repository; the build clones with it. */
  let githubToken: UsedGithubToken | null = null;
  try {
    const remote = await deps.listRefs(plan.repo);
    githubToken = remote.token ?? null;
    resolved = resolveRef(remote, plan.ref, plan.repo);
  } catch (error) {
    if (error instanceof GitRefError) throw fail(`${error.message}.`.replace(/\.\.$/, "."));
    throw error;
  }

  const now = (deps.now ?? (() => new Date()))();
  const jobId = newId();
  let first: SandboxFirst | null = null;
  if (turnOnFirst && deps.autoEnable !== undefined) {
    try {
      first = await planSandboxFirst(deps.db, deps.autoEnable, {
        plan: accountPlan,
        neededBy: { jobId, kind: "source_build" },
        newId,
        ...(deps.workflows === undefined ? {} : { workflows: deps.workflows }),
      });
    } catch (error) {
      if (error instanceof SandboxAutoEnableError) throw fail(error.message);
      throw error;
    }
  }
  const forUpdate = plan.purpose === "update" ? 1 : 0;
  // With sandbox builds off, the build row also requires the enable job it
  // waits for (or, for a new one, that no job runs), and a new enable job is
  // inserted last, only if the build's job row was.
  const claim = async (sandbox: SandboxFirst | null): Promise<boolean> => {
    const enableJobId = sandbox?.enableJobId ?? null;
    // Names only: what the job list, the live progress and usage data read.
    const inputJson = JSON.stringify({
      purpose: plan.purpose,
      origin: plan.origin,
      sandboxRun: sourceBuildRunId(jobId),
      runKind: "build",
      buildInstallId: plan.installId,
      buildConfirmed: true,
      ...(enableJobId === null ? {} : { sandboxEnableJob: enableJobId }),
    });
    const results = await deps.db.batch([
      deps.db
        .prepare(
          `INSERT INTO source_builds (id, install_id, purpose, origin, app_slug, repo, requested_ref,
             build_command_json, status, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'building', ?9, ?9
           WHERE (?10 = 0 OR (
               EXISTS (SELECT 1 FROM installs WHERE id = ?2 AND status = 'installed')
               AND NOT EXISTS (
                 SELECT 1 FROM jobs WHERE install_id = ?2 AND status IN ('queued', 'running')
               )
             ))
             AND ${SANDBOX_WORKER_JOBS_SQL}
             AND ${sandboxFirstGuardSql(sandbox, "?11")}
             AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
        )
        .bind(
          jobId,
          plan.installId,
          plan.purpose,
          plan.origin,
          plan.appSlug,
          plan.repo,
          plan.ref,
          JSON.stringify(plan.buildCommand),
          now.getTime(),
          forUpdate,
          enableJobId,
        ),
      deps.db
        .prepare(
          `INSERT INTO jobs (id, install_id, kind, status, input_json, started_by)
           SELECT ?1, ?2, 'source_build', 'queued', ?3, 'admin'
           WHERE EXISTS (SELECT 1 FROM source_builds WHERE id = ?1)`,
        )
        .bind(jobId, forUpdate === 1 ? plan.installId : null, inputJson),
      ...(sandbox?.kind === "enable" ? [sandboxEnableClaim(deps.db, sandbox, jobId)] : []),
    ]);
    return results[0]?.meta.changes === 1;
  };
  let claimed = await claim(first);
  if (!claimed) {
    const next = await afterRefusedClaim(deps.db, first);
    if (next !== null && "refused" in next) throw fail(next.refused);
    if (next !== null) {
      // Another start is turning sandbox builds on: wait for its job.
      first = next;
      claimed = await claim(first);
    }
  }
  if (!claimed) {
    throw fail(
      plan.purpose === "update"
        ? "Another job of this install is queued or running, sandbox builds are being changed, or Appflare is updating itself. Wait for it to finish, then try again."
        : "Sandbox builds are being changed, or Appflare is updating itself. Wait for it to finish, then try again.",
    );
  }
  const enableJobId = first?.enableJobId ?? null;
  const params: SourceBuildJobParams = {
    kind: "source_build",
    jobId,
    installId: plan.installId,
    purpose: plan.purpose,
    origin: plan.origin,
    repo: plan.repo,
    // The name the build is recorded under (a branch or tag), or the commit.
    ref: resolved.ref,
    commit: resolved.commit,
    buildCommand: plan.buildCommand,
    ...(plan.baseline === undefined ? {} : { baseline: plan.baseline }),
    avoidVersions: plan.avoidVersions,
    ...(plan.baseline?.install.container?.instanceType === undefined
      ? {}
      : { instanceType: plan.baseline.install.container.instanceType }),
    costConfirmed: true,
    ...(enableJobId === null ? {} : { sandboxEnableJob: enableJobId }),
    ...(githubToken === null ? {} : { githubToken }),
  };
  try {
    // The enable job first: the build waits for it.
    if (deps.autoEnable !== undefined) {
      await launchSandboxEnable(deps.db, deps.autoEnable, first, now);
    }
    const instance = await deps.createJob(jobId, params);
    await orm.update(jobs).set({ workflow_instance_id: instance.id }).where(eq(jobs.id, jobId));
  } catch (error) {
    const reason =
      error instanceof SandboxAutoEnableError
        ? `start: ${error.message}`
        : `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await orm.batch([
      orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: now })
        .where(eq(jobs.id, jobId)),
      orm
        .update(source_builds)
        .set({ status: "failed", updated_at: now })
        .where(eq(source_builds.id, jobId)),
    ]);
    throw fail(reason);
  }
  return { jobId };
}

/** A build as the review reads it. */
export interface SourceBuildRecord {
  row: typeof source_builds.$inferSelect;
  /** The verified artifact manifest; null until built. */
  manifest: ArtifactManifest | null;
  detected: RepositoryDetection | null;
  job: { status: string; error: string | null } | null;
}

export async function readSourceBuild(
  db: D1Database,
  buildId: string,
): Promise<SourceBuildRecord | null> {
  const orm = createDb(db);
  const [row] = await orm
    .select()
    .from(source_builds)
    .where(eq(source_builds.id, buildId))
    .limit(1);
  if (row === undefined) return null;
  const [job] = await orm
    .select({ status: jobs.status, error: jobs.error })
    .from(jobs)
    .where(eq(jobs.id, buildId))
    .limit(1);
  let detected: RepositoryDetection | null = null;
  if (row.detected_json !== null) {
    try {
      const parsed = repositoryDetectionSchema.safeParse(JSON.parse(row.detected_json));
      detected = parsed.success ? parsed.data : null;
    } catch {
      detected = null;
    }
  }
  return { row, manifest: parseManifest(row.manifest_json), detected, job: job ?? null };
}

/**
 * The state the review shows: `building` whose job ended without recording
 * the build (its Workflow died) counts as failed.
 */
export function effectiveStatus(record: SourceBuildRecord): SourceBuildRecord["row"]["status"] {
  const { row, job } = record;
  if (
    row.status === "building" &&
    job !== null &&
    (job.status === "failed" || job.status === "succeeded")
  ) {
    return "failed";
  }
  return row.status;
}

/** A built build, ready to install or update from; throws `SourceBuildError` otherwise. */
function builtOf(record: SourceBuildRecord | null): {
  row: SourceBuildRecord["row"];
  manifest: ArtifactManifest;
  detected: RepositoryDetection | null;
  prebuilt: PrebuiltBuildParams;
} {
  if (record === null) throw new SourceBuildError("There is no such build.");
  const status = effectiveStatus(record);
  if (status !== "built") {
    throw new SourceBuildError(
      status === "building"
        ? "The build is still running."
        : status === "used"
          ? "This build was already installed. Start a new build to install it again."
          : status === "discarded" || status === "discarding"
            ? "This build was thrown away. Start a new build."
            : "This build failed. Start a new build.",
    );
  }
  const { row, manifest } = record;
  if (
    manifest === null ||
    row.commit_sha === null ||
    row.ref === null ||
    row.version === null ||
    row.digest === null ||
    row.manifest_key === null ||
    row.artifact_key === null ||
    row.image === null ||
    row.built_at === null
  ) {
    throw new SourceBuildError("The build's record is incomplete. Start a new build.");
  }
  return {
    row,
    manifest,
    detected: record.detected,
    prebuilt: {
      buildId: row.id,
      origin: row.origin === "source" ? "source" : "repository",
      repo: row.repo,
      ref: row.ref,
      commit: row.commit_sha,
      app: manifest.app,
      version: row.version,
      digest: row.digest,
      manifestKey: row.manifest_key,
      artifactKey: row.artifact_key,
      image: row.image,
      builtAt: row.built_at.toISOString(),
    },
  };
}

/** The install form's fields for a reviewed build (the catalog form's, minus what the build decides). */
export type SourceInstallInput = Omit<StartInstallInput, "slug" | "buildConfirmed" | "appToken"> & {
  buildId: string;
};

export interface InstallSourceDeps {
  db: D1Database;
  workflows?: WorkflowLookup;
  createJob(id: string, params: InstallJobParams): Promise<{ id: string }>;
  listAccountWorkers?(): Promise<string[]>;
  /**
   * For an install protected with Cloudflare Access: why the account or the
   * token cannot protect it, or that Cloudflare could not be asked
   * (`accessCapabilityProblem`); null when they can. Without it the install
   * job's first Access step refuses instead.
   */
  accessPreflight?: () => Promise<AccessPreflightProblem | null>;
  now?: () => Date;
  newId?: () => string;
}

/**
 * The app slug an install from this build is recorded under, and its
 * catalog: a catalog app built from source keeps its catalog (the build
 * records its app key); a repository has none.
 */
export function installSlugOf(
  row: Pick<SourceBuildRecord["row"], "origin" | "app_slug" | "repo">,
): { slug: string; catalogId: string | null } {
  return row.origin === "source" && row.app_slug !== null
    ? parseAppKey(row.app_slug)
    : { slug: repositoryAppSlug(row.repo), catalogId: null };
}

/**
 * Installs a reviewed build: the form is checked against the build's own
 * catalog manifest (as the catalog's install form is against the signed
 * one), the install is recorded as not from the catalog, and the install job
 * installs the build as it is. The build is used once.
 */
export async function installSourceBuildCore(
  deps: InstallSourceDeps,
  input: SourceInstallInput,
): Promise<{ jobId: string; installId: string }> {
  const fail = (message: string) => new SourceBuildError(message);
  await refuseDuringSelfUpdate(deps.db, deps.workflows, fail);
  const built = builtOf(await readSourceBuild(deps.db, input.buildId));
  const { row, manifest, prebuilt } = built;
  if (row.purpose !== "install")
    throw fail("This build is for updating an install, not a new one.");
  const orm = createDb(deps.db);
  // Cloudflare refuses the deploy while Analytics Engine is off; say so before anything is created.
  const settings = await readSettings(orm, [SETTING.accountCapabilities]);
  const analyticsEngine = analyticsEngineRefusal(
    manifest.catalog.name,
    { requires: manifest.catalog.requires, bindings: manifest.worker.bindings },
    parseStoredCapabilities(settings.account_capabilities),
  );
  if (analyticsEngine !== null) throw fail(analyticsEngine);
  const accountPlan = await readAccountPlan(orm);
  const paidConfirmed = input.paidConfirmed || accountPlan === "paid";
  let resolved: ReturnType<typeof resolveInstallInput>;
  try {
    resolved = resolveInstallInput(manifest, { ...input, slug: manifest.app, paidConfirmed });
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error));
  }
  resolved = await withDerivedValues(manifest.catalog, resolved);
  const workerName = input.workerName;
  const review = reviewBuild(manifest, built.detected, workerName, prebuilt.origin);
  if (review.problems.length > 0) throw fail(review.problems.join(" "));
  const fixed = manifest.catalog.install.fixedWorkerName;
  const fixedName = catalogWorkerName(manifest.catalog);
  if (fixed && workerName !== fixedName) {
    throw fail(
      `${manifest.catalog.name} only works as the Worker "${fixedName}"; its Worker name cannot be changed.`,
    );
  }
  // Checked live, before anything is created, as for a catalog install.
  if (resolved.access === true && deps.accessPreflight !== undefined) {
    const problem = await deps.accessPreflight();
    if (problem !== null) throw fail(accessInstallRefusal(manifest.catalog.name, problem));
  }
  if (resolved.domain !== undefined) {
    const [held] = await orm
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.name, resolved.domain.hostname), isNull(resources.deleted_at)))
      .limit(1);
    if (held !== undefined) {
      throw fail(
        `${resolved.domain.hostname} is already a domain of another app. Remove it there first.`,
      );
    }
  }
  if (deps.listAccountWorkers !== undefined) {
    let existing: string[] = [];
    try {
      existing = await deps.listAccountWorkers();
    } catch {
      // The install job checks the account again before creating anything.
    }
    if (existing.includes(workerName)) {
      throw fail(
        `A Worker named "${workerName}" already exists in this account. Appflare does not adopt existing Workers; choose another name.`,
      );
    }
  }
  const { slug, catalogId } = installSlugOf(row);
  const now = (deps.now ?? (() => new Date()))();
  const jobId = (deps.newId ?? (() => ulid()))();
  const installId = row.install_id;
  const inputJson = JSON.stringify({
    slug,
    // The app's name, for what names the install before it records its manifest.
    appName: manifest.catalog.name,
    version: prebuilt.version,
    workerName,
    secrets: Object.keys(resolved.secrets),
    // Binding names only: connection strings hold database passwords.
    ...(Object.keys(resolved.hyperdrive).length === 0
      ? {}
      : { hyperdrive: Object.keys(resolved.hyperdrive) }),
    vars: resolved.vars,
    paidConfirmed,
    requirementsConfirmed: input.requirementsConfirmed,
    origin: prebuilt.origin,
    buildId: prebuilt.buildId,
    ...(resolved.emailRouting === undefined ? {} : { emailRouting: resolved.emailRouting }),
    ...(resolved.domain === undefined ? {} : { domain: resolved.domain }),
    ...(resolved.access === true ? { access: true } : {}),
  });
  const displayName = input.displayName ?? null;
  const [, claimedInstall, claimedJob] = await deps.db.batch([
    // A failed install of the same Worker name that holds nothing is retired, as for catalog apps.
    deps.db
      .prepare(
        `UPDATE installs SET status = 'uninstalled', uninstalled_at = ?2, updated_at = ?2
         WHERE status = 'failed' AND worker_name = ?1
           AND NOT EXISTS (
             SELECT 1 FROM resources r WHERE r.install_id = installs.id AND r.deleted_at IS NULL
           )`,
      )
      .bind(workerName, now.getTime()),
    deps.db
      .prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, display_name,
           catalog_version, artifact_url, artifact_digest, pin_sha, status, config_json,
           installed_at, updated_at, build_kind, sandbox_image, built_at, origin, source_url,
           source_ref, catalog_id)
         SELECT ?1, ?2, ?3, coalesce(?4, ?3), ?4, ?5, ?6, ?7, ?8, 'installing', ?9, ?10, ?10,
           'sandbox', ?11, ?12, ?13, ?14, ?15, ?18
         WHERE NOT EXISTS (SELECT 1 FROM installs WHERE id = ?1)
           AND NOT EXISTS (
             SELECT 1 FROM installs
             WHERE status != 'uninstalled'
               AND (worker_name = ?3 OR (?16 = 1 AND app_slug = ?2 AND catalog_id IS ?18))
           )
           AND EXISTS (SELECT 1 FROM source_builds WHERE id = ?17 AND status = 'built')
           AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
      )
      .bind(
        installId,
        slug,
        workerName,
        displayName,
        prebuilt.version,
        sandboxObjectUrl(prebuilt.artifactKey),
        prebuilt.digest,
        prebuilt.commit,
        JSON.stringify(resolved.vars),
        now.getTime(),
        prebuilt.image,
        Date.parse(prebuilt.builtAt),
        prebuilt.origin,
        repositoryUrl(prebuilt.repo),
        prebuilt.ref,
        fixed ? 1 : 0,
        prebuilt.buildId,
        catalogId,
      ),
    deps.db
      .prepare(
        `INSERT INTO jobs (id, install_id, kind, status, input_json)
         SELECT ?1, ?2, 'install', 'queued', ?3
         WHERE EXISTS (SELECT 1 FROM installs WHERE id = ?2 AND status = 'installing')
           AND NOT EXISTS (SELECT 1 FROM jobs WHERE install_id = ?2)`,
      )
      .bind(jobId, installId, inputJson),
    deps.db
      .prepare(
        `UPDATE source_builds SET status = 'used', updated_at = ?2
         WHERE id = ?1 AND status = 'built' AND EXISTS (SELECT 1 FROM jobs WHERE id = ?3)`,
      )
      .bind(prebuilt.buildId, now.getTime(), jobId),
  ]);
  if (claimedInstall?.meta.changes !== 1 || claimedJob?.meta.changes !== 1) {
    throw fail(
      `The Worker name "${workerName}" is taken by another install, the build was installed or thrown away meanwhile, or Appflare is updating itself. Reload the page.`,
    );
  }
  if (input.rememberPaidPlan === true && input.paidConfirmed && accountPlan !== "paid") {
    await writeAccountPlan(orm, "paid");
  }
  const params: InstallJobParams = {
    kind: "install",
    jobId,
    installId,
    slug,
    version: prebuilt.version,
    workerName,
    prebuilt,
    secrets: resolved.secrets,
    ...(Object.keys(resolved.hyperdrive).length === 0 ? {} : { hyperdrive: resolved.hyperdrive }),
    vars: resolved.vars,
    ...seedParams(resolved.seed),
    paidConfirmed,
    requirementsConfirmed: input.requirementsConfirmed,
    ...(resolved.emailRouting === undefined ? {} : { emailRouting: resolved.emailRouting }),
    ...(resolved.domain === undefined ? {} : { domain: resolved.domain as InstallDomainInput }),
    ...(resolved.access === true ? { access: true } : {}),
  };
  try {
    const instance = await deps.createJob(jobId, params);
    await orm.update(jobs).set({ workflow_instance_id: instance.id }).where(eq(jobs.id, jobId));
  } catch (error) {
    const reason = `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await orm.batch([
      orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: now })
        .where(eq(jobs.id, jobId)),
      orm
        .update(installs)
        .set({ status: "failed", updated_at: now })
        .where(eq(installs.id, installId)),
    ]);
    throw fail(reason);
  }
  return { jobId, installId };
}

/** What updating from a reviewed rebuild asks the admin for. */
export interface SourceUpdateNeeds {
  /** Secrets the rebuild declares that the install does not have yet. */
  needsSecrets: CatalogSecret[];
  /** Names among `needsSecrets` the Worker already has (asked for again for a derived var). */
  heldSecrets?: string[];
  /** Why the new version cannot be checked on a preview first; null when it can. */
  skipsPreview: string | null;
}

/** What updating the install from `manifest` asks for. */
export async function sourceUpdateNeeds(
  db: D1Database,
  install: typeof installs.$inferSelect,
  manifest: ArtifactManifest,
): Promise<SourceUpdateNeeds> {
  const recorded = await createDb(db)
    .select({ name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, install.id),
        eq(resources.kind, "secret"),
        isNull(resources.deleted_at),
      ),
    );
  // A derived secret the Worker lacks, or a derived var the install has no
  // value for, asks for its source.
  const needsSecrets = secretsToAskFor(
    manifest.catalog.secrets,
    missingSecrets(
      manifest.catalog.secrets,
      recorded.map((r) => r.name),
    ),
    sourcesOfUnsetDerivedVars(manifest.catalog.vars, parseStoredVars(install.config_json)),
  );
  const held = heldSecrets(
    needsSecrets,
    recorded.map((r) => r.name),
  );
  return {
    needsSecrets,
    ...(held.length === 0 ? {} : { heldSecrets: held }),
    skipsPreview: updatePath(
      manifest,
      install.do_migration_tag ?? lastDurableObjectTagOf(install.manifest_json),
      workerExportsOf(install.manifest_json),
    ).skipPreview,
  };
}

/**
 * Updates an install from its reviewed rebuild through the ordinary update
 * job (snapshot, preview check, promotion, rollback). New secrets need
 * values, and a version that cannot be checked on a preview needs the
 * admin's confirmation, both given here.
 */
export async function updateFromSourceBuildCore(
  deps: StartJobDeps<UpdateJobParams>,
  input: { buildId: string; secrets?: Record<string, string>; confirmNoPreview?: boolean },
): Promise<{ jobId: string }> {
  const fail = (message: string) => new SourceBuildError(message);
  const built = builtOf(await readSourceBuild(deps.db, input.buildId));
  const { row, manifest, prebuilt } = built;
  if (row.purpose !== "update") throw fail("This build is for a new install, not an update.");
  const install = await readInstall(deps.db, row.install_id);
  const refusal = statusRefusal(install.status);
  if (refusal !== null) throw fail(refusal);
  const review = reviewBuild(manifest, built.detected, install.worker_name, prebuilt.origin);
  if (review.problems.length > 0) throw fail(review.problems.join(" "));
  const needs = await sourceUpdateNeeds(deps.db, install, manifest);
  if (needs.skipsPreview !== null && input.confirmNoPreview !== true) {
    throw fail(`${needs.skipsPreview}. Confirm updating without a preview check.`);
  }
  const given = input.secrets ?? {};
  const unknown = Object.keys(given).filter((n) => !needs.needsSecrets.some((s) => s.name === n));
  if (unknown.length > 0) throw fail(`This update does not take: ${unknown.join(", ")}.`);
  const entered: Record<string, string> = {};
  for (const secret of needs.needsSecrets) {
    const value = given[secret.name] ?? "";
    if (value.length === 0) throw fail(`${secret.label} (${secret.name}) is required.`);
    const problem = secretValueProblem(secret, value);
    if (problem !== null) throw fail(problem);
    entered[secret.name] = value;
  }
  const secrets = await withDerivedSecrets(manifest.catalog.secrets, entered);
  // A derived var follows its source's new value; the job stores it.
  const vars = await derivedVarValues(manifest.catalog.vars, entered);
  const orm = createDb(deps.db);
  const now = (deps.now ?? (() => new Date()))();
  // Taken first, so two tabs cannot both update from it; given back if the update cannot start.
  const taken = await orm
    .update(source_builds)
    .set({ status: "used", updated_at: now })
    .where(and(eq(source_builds.id, row.id), eq(source_builds.status, "built")))
    .returning({ id: source_builds.id });
  if (taken.length === 0)
    throw fail("This build was used or thrown away meanwhile. Reload the page.");
  const jobId = (deps.newId ?? (() => ulid()))();
  try {
    return await claim(deps, {
      installId: install.id,
      kind: "update",
      inputJson: JSON.stringify({
        installId: install.id,
        fromVersion: install.catalog_version,
        version: prebuilt.version,
        secrets: Object.keys(secrets),
        ...(Object.keys(vars).length === 0 ? {} : { vars: Object.keys(vars) }),
        origin: prebuilt.origin,
        buildId: prebuilt.buildId,
      }),
      params: {
        kind: "update",
        jobId,
        installId: install.id,
        version: prebuilt.version,
        secrets,
        ...(Object.keys(vars).length === 0 ? {} : { vars }),
        prebuilt,
        confirmNoPreview: input.confirmNoPreview === true,
      },
    });
  } catch (error) {
    await orm
      .update(source_builds)
      .set({ status: "built", updated_at: now })
      .where(and(eq(source_builds.id, row.id), eq(source_builds.status, "used")));
    if (error instanceof VersionActionError) throw fail(error.message);
    throw error;
  }
}

/** What throwing a build away needs. */
export interface DiscardSourceBuildDeps {
  db: D1Database;
  /** Deletes an install's builds but `keepVersions`; absent without the `SANDBOX` binding. */
  cleanup?: (installId: string, keepVersions: string[]) => Promise<void>;
  now?: () => Date;
}

/** The `cleanup` of `DiscardSourceBuildDeps` through the `SANDBOX` binding; none without it. */
export function sandboxBuildCleanup(env: {
  SANDBOX?: unknown;
}): Pick<DiscardSourceBuildDeps, "cleanup"> {
  const binding = sandboxBinding(env);
  if (binding === undefined) return {};
  return {
    cleanup: async (installId, keepVersions) => {
      await binding.cleanup({ installId, keepVersions });
    },
  };
}

/**
 * How long after a build was taken for an install or update its version is
 * kept regardless: the build is marked used a moment before its job's row
 * exists, so no running job protects it yet.
 */
const TAKEN_RECENTLY_MS = 60 * 60 * 1000;

/**
 * How long a thrown-away build whose files are not deleted yet waits before
 * the cron tries again, so one whose clean-up keeps failing does not take a
 * turn in every run.
 */
const DISCARD_RETRY_MS = 60 * 60 * 1000;

/**
 * SQL condition on the `source_builds` row being written: no job of its
 * install, nor its own job, is queued or running. Columns are named in full:
 * unqualified, they would mean the `jobs` columns inside the subquery.
 */
const NO_ACTIVE_JOB_OF_BUILD_SQL = sql`NOT EXISTS (
  SELECT 1 FROM jobs
  WHERE (jobs.install_id = source_builds.install_id OR jobs.id = source_builds.id)
    AND jobs.status IN ('queued', 'running')
)`;

/** What became of a thrown-away build's files. */
export type DiscardedFiles =
  /** Deleted, with whatever else of the install nothing uses. */
  | "deleted"
  /** No sandbox Worker to ask: turning sandbox builds off deletes the bucket, files and all. */
  | "no-sandbox"
  /** Not yet: a job of the install is queued or running. The cron deletes them once it ends. */
  | "waiting"
  /** The sandbox Worker could not delete them. The cron tries again later. */
  | "failed"
  /**
   * More versions are in use than the sandbox Worker takes in one clean-up,
   * so they are left to the install's next update (which keeps two versions)
   * or its uninstall (which keeps none).
   */
  | "left";

/**
 * Throws a build away. Its record first becomes `discarding`: never offered
 * again, its files not deleted yet. Once the files are deleted from the
 * sandbox Worker's bucket (for an update's build, with every other version
 * of the install except those the install and its snapshots use, those of
 * other builds waiting for review, and that of one just taken for a job), it
 * becomes `discarded`. A build still running cannot be thrown away. While a
 * job of the install is queued or running, or when the clean-up fails, the
 * build stays `discarding` and the cron finishes it later: an update may be
 * reading the build it took, a rebuild writing its own. So a record that
 * says `discarded` means the files are gone, and one the review offers has
 * its files.
 *
 * `idleBefore` is the expiry of builds nobody used: the build is thrown away
 * only if it has not changed since then and no job of its install is queued
 * or running, checked in the same write that claims it.
 */
export async function discardSourceBuildCore(
  deps: DiscardSourceBuildDeps,
  buildId: string,
  options: { idleBefore?: Date } = {},
): Promise<DiscardedFiles> {
  const record = await readSourceBuild(deps.db, buildId);
  if (record === null) throw new SourceBuildError("There is no such build.");
  const status = effectiveStatus(record);
  if (status === "building")
    throw new SourceBuildError("The build is still running. Wait for it to finish.");
  if (status !== "built" && status !== "failed") {
    throw new SourceBuildError(
      status === "used"
        ? "This build is in use by an install."
        : "This build was thrown away already.",
    );
  }
  const now = (deps.now ?? (() => new Date()))();
  const idleBefore = options.idleBefore;
  const claimed = await createDb(deps.db)
    .update(source_builds)
    .set({ status: deps.cleanup === undefined ? "discarded" : "discarding", updated_at: now })
    .where(
      and(
        eq(source_builds.id, buildId),
        inArray(source_builds.status, ["built", "failed", "building"]),
        idleBefore === undefined ? undefined : lt(source_builds.updated_at, idleBefore),
        idleBefore === undefined ? undefined : NO_ACTIVE_JOB_OF_BUILD_SQL,
      ),
    )
    .returning({ id: source_builds.id });
  if (claimed.length === 0)
    throw new SourceBuildError("The build changed meanwhile. Reload the page.");
  if (deps.cleanup === undefined) return "no-sandbox";
  return deleteDiscardedFiles(deps.db, deps.cleanup, buildId, record.row.install_id, now);
}

/** Records a `discarding` build as `discarded`. */
async function markDiscarded(db: D1Database, buildId: string, now: Date): Promise<void> {
  await createDb(db)
    .update(source_builds)
    .set({ status: "discarded", updated_at: now })
    .where(and(eq(source_builds.id, buildId), eq(source_builds.status, "discarding")));
}

/** Deletes the files of a `discarding` build, then records it `discarded`. */
async function deleteDiscardedFiles(
  db: D1Database,
  cleanup: NonNullable<DiscardSourceBuildDeps["cleanup"]>,
  buildId: string,
  installId: string,
  now: Date,
): Promise<DiscardedFiles> {
  const orm = createDb(db);
  const [active] = await orm
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.install_id, installId), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  if (active !== undefined) return "waiting";
  const [install] = await orm.select().from(installs).where(eq(installs.id, installId)).limit(1);
  const keep =
    install === undefined || install.status === "uninstalled"
      ? []
      : await versionsInUse(db, install.id, install.catalog_version);
  // Other builds of the install waiting for review keep their objects too,
  // as does one taken just now by an install or update about to start.
  const others = await orm
    .select({
      status: source_builds.status,
      version: source_builds.version,
      updatedAt: source_builds.updated_at,
    })
    .from(source_builds)
    .where(
      and(
        eq(source_builds.install_id, installId),
        inArray(source_builds.status, ["built", "used"]),
      ),
    );
  for (const other of others) {
    if (other.version === null) continue;
    if (other.status === "built" || now.getTime() - other.updatedAt.getTime() < TAKEN_RECENTLY_MS) {
      keep.push(other.version);
    }
  }
  const request = { installId, keepVersions: [...new Set(keep)] };
  // What the sandbox Worker accepts, checked here so a refusal is not mistaken for a failure to retry.
  const accepted = buildCleanupRequestSchema.safeParse(request);
  if (!accepted.success) {
    console.warn(
      "source builds: a thrown-away build's files are left to the install's next update or uninstall",
      {
        installId,
        keep: request.keepVersions.length,
        error: accepted.error.issues[0]?.message ?? "refused",
      },
    );
    await markDiscarded(db, buildId, now);
    return "left";
  }
  try {
    await cleanup(installId, request.keepVersions);
  } catch (error) {
    console.warn(
      "source builds: could not delete a thrown-away build's files; trying again later",
      {
        installId,
        keep: request.keepVersions.length,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    // Waits `DISCARD_RETRY_MS` from now before the next try.
    await orm
      .update(source_builds)
      .set({ updated_at: now })
      .where(and(eq(source_builds.id, buildId), eq(source_builds.status, "discarding")));
    return "failed";
  }
  await markDiscarded(db, buildId, now);
  return "deleted";
}

/**
 * At most this many builds are handled per cron run; the rest wait for the
 * next run (every 30 minutes). The expiry runs in a unit of its own, whose
 * invocation has 50 subrequests on Workers Free, and every D1 query and the
 * sandbox Worker call count as one: the read of what is due, then up to 9
 * per build (the build and its job, the claim, the job check, the install,
 * its versions in use, its other builds, the clean-up, the final record), so
 * 4 builds stay at 37. Workers Paid allows far more, but the account may
 * have moved back to Free with builds left over.
 */
export const EXPIRED_BUILDS_PER_RUN = 4;

/** What one run of the expiry did, by build id. */
export interface ExpiredSourceBuilds {
  /** Thrown away, files deleted (or no sandbox Worker holds them). */
  discarded: string[];
  /** Thrown away, files not deleted yet (a job of the install runs, or the clean-up failed); tried again later. */
  pending: string[];
  /** Thrown away, files left to the install's next update or uninstall. */
  left: string[];
  /** Changed between the read and the discard; left as they are. */
  skipped: string[];
  /** More builds are due than this run took. */
  more: boolean;
}

interface DueBuild {
  id: string;
  status: string;
  install_id: string;
}

/**
 * Builds the expiry handles next, oldest first: thrown away earlier with
 * their files not deleted yet (after `DISCARD_RETRY_MS`), and builds nobody
 * used for `UNUSED_BUILD_DAYS`. Never one an install or a snapshot uses (by
 * version, or by artifact), one still building, one an install or update
 * has taken (`used`), or any build of an install with a job queued or
 * running.
 */
async function dueSourceBuilds(db: D1Database, now: Date, limit: number): Promise<DueBuild[]> {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.status, b.install_id FROM source_builds b LEFT JOIN jobs j ON j.id = b.id
       WHERE (
           (b.status = 'discarding' AND b.updated_at < ?2)
           OR (b.updated_at < ?1
             AND (b.status IN ('built', 'failed')
               OR (b.status = 'building' AND j.status IN ('failed', 'succeeded')))
             AND NOT EXISTS (
               SELECT 1 FROM installs i
               WHERE i.status != 'uninstalled'
                 AND ((i.id = b.install_id AND i.catalog_version = b.version)
                   OR i.artifact_url = ?3 || b.artifact_key)
             )
             AND NOT EXISTS (
               SELECT 1 FROM snapshots s JOIN installs i ON i.id = s.install_id
               WHERE i.status != 'uninstalled'
                 AND ((s.install_id = b.install_id AND s.catalog_version = b.version)
                   OR s.artifact_url = ?3 || b.artifact_key)
             ))
         )
         AND (j.status IS NULL OR j.status NOT IN ('queued', 'running'))
         AND NOT EXISTS (
           SELECT 1 FROM jobs a WHERE a.install_id = b.install_id AND a.status IN ('queued', 'running')
         )
       ORDER BY b.updated_at, b.id
       LIMIT ?4`,
    )
    .bind(
      now.getTime() - UNUSED_BUILD_MS,
      now.getTime() - DISCARD_RETRY_MS,
      sandboxObjectUrl(""),
      limit,
    )
    .all<DueBuild>();
  return results;
}

/** Whether the expiry has anything to do: one read, for the cron before it starts the unit. */
export async function sourceBuildExpiryDue(db: D1Database, now = new Date()): Promise<boolean> {
  return (await dueSourceBuilds(db, now, 1)).length > 0;
}

/**
 * The cron's part (the `expireSourceBuilds` unit): throws away builds nobody
 * installed, updated from or threw away within `UNUSED_BUILD_DAYS` of being
 * built (or of failing), through `discardSourceBuildCore`, and finishes
 * those whose files were left for later. At most `limit` per run.
 */
export async function expireUnusedSourceBuildsCore(
  deps: DiscardSourceBuildDeps & { limit?: number },
): Promise<ExpiredSourceBuilds> {
  const now = (deps.now ?? (() => new Date()))();
  const idleBefore = new Date(now.getTime() - UNUSED_BUILD_MS);
  const limit = deps.limit ?? EXPIRED_BUILDS_PER_RUN;
  const due = await dueSourceBuilds(deps.db, now, limit + 1);
  const expired: ExpiredSourceBuilds = {
    discarded: [],
    pending: [],
    left: [],
    skipped: [],
    more: due.length > limit,
  };
  for (const build of due.slice(0, limit)) {
    let files: DiscardedFiles;
    if (build.status !== "discarding") {
      try {
        files = await discardSourceBuildCore(deps, build.id, { idleBefore });
      } catch (error) {
        if (!(error instanceof SourceBuildError)) throw error;
        expired.skipped.push(build.id);
        continue;
      }
    } else if (deps.cleanup === undefined) {
      await markDiscarded(deps.db, build.id, now);
      files = "no-sandbox";
    } else {
      files = await deleteDiscardedFiles(deps.db, deps.cleanup, build.id, build.install_id, now);
    }
    if (files === "deleted" || files === "no-sandbox") expired.discarded.push(build.id);
    else if (files === "left") expired.left.push(build.id);
    else expired.pending.push(build.id);
  }
  return expired;
}

/** The cron's log line for an expiry run, or null when it did nothing. */
export function expiredSourceBuildsLog(expired: ExpiredSourceBuilds): string | null {
  const parts: string[] = [];
  if (expired.discarded.length > 0) {
    parts.push(`${expired.discarded.length} unused build(s) thrown away with their files`);
  }
  if (expired.pending.length > 0) {
    parts.push(
      `the files of ${expired.pending.length} not deleted yet (a job of the app runs, or the clean-up failed; tried again later)`,
    );
  }
  if (expired.left.length > 0) {
    parts.push(
      `the files of ${expired.left.length} left to the app's next update or uninstall (too many versions in use)`,
    );
  }
  if (parts.length === 0) return null;
  return `source builds: ${parts.join("; ")}${expired.more ? "; more next run" : ""}`;
}

/** What "Check for changes" found. */
export interface SourceChanges {
  repo: string;
  ref: string;
  /** The ref is a commit, which never moves. */
  pinned: boolean;
  installed: string | null;
  latest: string;
  changed: boolean;
}

/** The newest commit at the branch or tag an install from a repository was built from. */
export async function checkSourceChangesCore(
  deps: { db: D1Database; listRefs(repo: string): Promise<ReadRefs> },
  installId: string,
): Promise<SourceChanges> {
  const install = await readInstall(deps.db, installId).catch((error: unknown) => {
    throw new SourceBuildError(error instanceof Error ? error.message : String(error));
  });
  if (install.origin === "catalog") {
    throw new SourceBuildError(
      "This app comes from the catalog; the catalog says when it has an update.",
    );
  }
  const repo = repoOfUrl(install.source_url);
  if (repo === null || install.source_ref === null) {
    throw new SourceBuildError("This install does not record the repository it came from.");
  }
  let resolved: ReturnType<typeof resolveRef>;
  try {
    resolved = resolveRef(await deps.listRefs(repo), install.source_ref, repo);
  } catch (error) {
    if (error instanceof GitRefError) throw new SourceBuildError(error.message);
    throw error;
  }
  return {
    repo,
    ref: install.source_ref,
    pinned: resolved.kind === "commit",
    installed: install.pin_sha,
    latest: resolved.commit,
    changed: resolved.commit !== install.pin_sha,
  };
}
