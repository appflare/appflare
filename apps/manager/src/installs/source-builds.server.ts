import {
  type ArtifactManifest,
  artifactManifestSchema,
  type BuildCommandChoice,
  buildCommandChoiceSchema,
  type CatalogManifest,
  type CatalogSecret,
  githubRepositorySchema,
  gitRefSchema,
  hasFixedWorkerName,
  type IndexApp,
  parseRepositoryInput,
  type RepositoryDetection,
  repositoryDetectionSchema,
  repositoryUrl,
  type SandboxInfo,
  sandboxObjectUrl,
} from "@appflare/schema";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import type { AccountPlan } from "../account/plan";
import { readAccountPlan, writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import {
  type InstallOrigin,
  installs,
  jobs,
  resources,
  snapshots,
  source_builds,
} from "../db/schema";
import type { UsedGithubToken } from "../github/access.server";
import type { InstallJobParams } from "../jobs/install";
import type { PrebuiltBuildParams } from "../jobs/install/artifact-source";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import { NO_ACTIVE_SELF_UPDATE_SQL, refuseDuringSelfUpdate } from "../jobs/self-update/guard";
import { type SourceBuildJobParams, sourceBuildRunId } from "../jobs/source-build";
import type { UpdateJobParams } from "../jobs/update";
import { lastDurableObjectTagOf, missingSecrets, updatePath } from "../jobs/update/plan";
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
import { buildsFromRepository } from "../sandbox/binding";
import { ENABLE_SANDBOX_PLACE, UPDATE_SANDBOX_HINT } from "../sandbox/connect-copy";
import { secretsToAskFor, withDerivedSecrets } from "./derived-secrets";
import { GitRefError, type RemoteRefs, resolveRef } from "./git-refs";
import type { InstallDomainInput, StartInstallInput } from "./install-input";
import { repositoryAppSlug, reviewBuild } from "./source-review";
import { resolveInstallInput } from "./start-install.server";
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

/** Versions an install's builds use now: its own and its snapshots' (a rollback reads them). */
async function versionsInUse(
  db: D1Database,
  installId: string,
  current: string,
): Promise<string[]> {
  const rows = await createDb(db)
    .selectDistinct({ version: snapshots.catalog_version })
    .from(snapshots)
    .where(and(eq(snapshots.install_id, installId), isNotNull(snapshots.catalog_version)))
    .limit(15);
  return [...new Set([current, ...rows.map((r) => r.version ?? "").filter((v) => v.length > 0)])];
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
      appSlug: app.slug,
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
      baseline = (await deps.loadCatalogApp(install.app_slug)).catalog;
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
    appSlug: install.origin === "source" ? install.app_slug : null,
    repo,
    ref: install.source_ref,
    buildCommand: await lastBuildCommand(deps.db, install.id),
    ...(baseline === undefined ? {} : { baseline }),
    avoidVersions: await versionsInUse(deps.db, install.id, install.catalog_version),
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
    ...(plan.baseline?.install.sandbox?.instanceType === undefined
      ? {}
      : { instanceType: plan.baseline.install.sandbox.instanceType }),
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
          : status === "discarded"
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
  now?: () => Date;
  newId?: () => string;
}

/** The app slug an install from this build is recorded under. */
export function installSlugOf(
  row: Pick<SourceBuildRecord["row"], "origin" | "app_slug" | "repo">,
): string {
  return row.origin === "source" && row.app_slug !== null
    ? row.app_slug
    : repositoryAppSlug(row.repo);
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
  const accountPlan = await readAccountPlan(orm);
  const paidConfirmed = input.paidConfirmed || accountPlan === "paid";
  let resolved: ReturnType<typeof resolveInstallInput>;
  try {
    resolved = resolveInstallInput(manifest, { ...input, slug: manifest.app, paidConfirmed });
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error));
  }
  resolved = {
    ...resolved,
    secrets: await withDerivedSecrets(manifest.catalog.secrets, resolved.secrets),
  };
  const workerName = input.workerName;
  const review = reviewBuild(manifest, built.detected, workerName, prebuilt.origin);
  if (review.problems.length > 0) throw fail(review.problems.join(" "));
  const fixed = hasFixedWorkerName(manifest.catalog.install);
  if (fixed && workerName !== manifest.catalog.install.workerName) {
    throw fail(
      `${manifest.catalog.name} only works as the Worker "${manifest.catalog.install.workerName}"; its Worker name cannot be changed.`,
    );
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
  const slug = installSlugOf(row);
  const now = (deps.now ?? (() => new Date()))();
  const jobId = (deps.newId ?? (() => ulid()))();
  const installId = row.install_id;
  const inputJson = JSON.stringify({
    slug,
    version: prebuilt.version,
    workerName,
    secrets: Object.keys(resolved.secrets),
    vars: resolved.vars,
    paidConfirmed,
    requirementsConfirmed: input.requirementsConfirmed,
    origin: prebuilt.origin,
    buildId: prebuilt.buildId,
    ...(resolved.emailRouting === undefined ? {} : { emailRouting: resolved.emailRouting }),
    ...(resolved.domain === undefined ? {} : { domain: resolved.domain }),
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
           source_ref)
         SELECT ?1, ?2, ?3, coalesce(?4, ?3), ?4, ?5, ?6, ?7, ?8, 'installing', ?9, ?10, ?10,
           'sandbox', ?11, ?12, ?13, ?14, ?15
         WHERE NOT EXISTS (SELECT 1 FROM installs WHERE id = ?1)
           AND NOT EXISTS (
             SELECT 1 FROM installs
             WHERE status != 'uninstalled' AND (worker_name = ?3 OR (?16 = 1 AND app_slug = ?2))
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
    vars: resolved.vars,
    paidConfirmed,
    requirementsConfirmed: input.requirementsConfirmed,
    ...(resolved.emailRouting === undefined ? {} : { emailRouting: resolved.emailRouting }),
    ...(resolved.domain === undefined ? {} : { domain: resolved.domain as InstallDomainInput }),
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
  return {
    // A derived secret the Worker lacks asks for its source.
    needsSecrets: secretsToAskFor(
      manifest.catalog.secrets,
      missingSecrets(
        manifest.catalog.secrets,
        recorded.map((r) => r.name),
      ),
    ),
    skipsPreview: updatePath(
      manifest,
      install.do_migration_tag ?? lastDurableObjectTagOf(install.manifest_json),
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
    entered[secret.name] = value;
  }
  const secrets = await withDerivedSecrets(manifest.catalog.secrets, entered);
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
        origin: prebuilt.origin,
        buildId: prebuilt.buildId,
      }),
      params: {
        kind: "update",
        jobId,
        installId: install.id,
        version: prebuilt.version,
        secrets,
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

// TODO: a build nobody installs or throws away keeps its files in the
// sandbox Worker's bucket (a few MB each) until an admin throws it away or,
// for a rebuild, the install's next update clears its old builds. An R2
// lifecycle rule on the bucket would expire them; the bucket is created by
// the sandbox enable job, which does not set one yet.

/**
 * Throws a build away: its record is kept as discarded and its objects are
 * deleted from the sandbox Worker's bucket (for an update's build, all but
 * the versions the install and its snapshots still use). A build still
 * running cannot be thrown away.
 */
export async function discardSourceBuildCore(
  deps: {
    db: D1Database;
    /** Deletes an install's builds but `keepVersions`; absent without the `SANDBOX` binding. */
    cleanup?: (installId: string, keepVersions: string[]) => Promise<void>;
    now?: () => Date;
  },
  buildId: string,
): Promise<void> {
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
  const orm = createDb(deps.db);
  const discarded = await orm
    .update(source_builds)
    .set({ status: "discarded", updated_at: now })
    .where(
      and(
        eq(source_builds.id, buildId),
        inArray(source_builds.status, ["built", "failed", "building"]),
      ),
    )
    .returning({ id: source_builds.id });
  if (discarded.length === 0)
    throw new SourceBuildError("The build changed meanwhile. Reload the page.");
  if (deps.cleanup === undefined) return;
  const { row } = record;
  const [install] = await orm
    .select()
    .from(installs)
    .where(eq(installs.id, row.install_id))
    .limit(1);
  const keep =
    install === undefined || install.status === "uninstalled"
      ? []
      : await versionsInUse(deps.db, install.id, install.catalog_version);
  // Other builds of the install waiting for review keep their objects too.
  const waiting = await orm
    .select({ version: source_builds.version })
    .from(source_builds)
    .where(and(eq(source_builds.install_id, row.install_id), eq(source_builds.status, "built")));
  for (const w of waiting) if (w.version !== null) keep.push(w.version);
  try {
    await deps.cleanup(row.install_id, [...new Set(keep)]);
  } catch {
    // Housekeeping: the objects stay in the bucket; nothing depends on them.
  }
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
