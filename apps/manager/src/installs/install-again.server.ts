import {
  type BuildCommandChoice,
  buildCommandChoiceSchema,
  sandboxObjectUrl,
} from "@appflare/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { installAppKey, OFFICIAL_CATALOG_ID } from "../catalog/sources";
import { createDb } from "../db/client";
import { installs, jobs, resources, source_builds } from "../db/schema";
import { sandboxFetch } from "../sandbox/binding";
import { installLabel } from "./display-name";
import { buildIdOfInput, type InstallAgainRecord, type InstallAgainSource } from "./install-again";
import { installDomainInput } from "./install-input";
import { namedInstall } from "./install-names.server";
import { isDataResourceKind } from "./resource-kinds";
import type { StartSourceBuildRequest } from "./source-builds.server";
import { uninstallJob } from "./start-uninstall.server";

/**
 * What "Install again" reads of a failed install (see ./install-again.ts):
 * the choices its install job recorded, for the form, what it left in the
 * account, which starting the new install removes first, and for an install
 * from a repository the build it was installed from. Also what both install
 * forms add to their start to replace it. Server only.
 */

/** A failed install a new one replaces, as starting the new install needs it. */
export interface ReplacedInstall {
  id: string;
  workerName: string;
  buildKind: string;
  version: string;
  /** Where its code came from (`INSTALL_ORIGINS`). */
  origin: string;
  /** Its artifact: the release, or for an install from a repository its build's zip. */
  artifactUrl: string;
  /** Not from the catalog: the build its latest install job installed; null when none. */
  buildId: string | null;
  /**
   * Anything of it still in the account that needs removing: `leftovers` is
   * not empty. Secrets alone do not count: they exist only on its Worker,
   * so with the Worker gone they are gone too.
   */
  hasLeftovers: boolean;
  /** Its data resources still in the account: the removal deletes every one, keeping nothing. */
  dataResourceIds: string[];
  /** Worker names it recorded that are still in the account. */
  workerNames: string[];
  leftovers: Array<{ kind: string; name: string }>;
}

/** Why a failed install cannot be installed again, in words for the admin. */
export const INSTALL_AGAIN_REFUSALS = {
  missing: "There is no such install to install again.",
  notFailed:
    "Only an install that did not finish can be installed again. This one finished, or it was removed or installed again already.",
  notCatalog:
    "This install was built from a repository or from source, so it is installed again from the review of its build.",
  fromCatalog:
    "This install came from the catalog, so it is installed again from the app's catalog page.",
  busy: "A job of this install is running. Wait for it to finish, then install it again.",
  otherApp: "Install again installs the same app again; this form is for another one.",
} as const;

/** Why the build an install from a repository was made from cannot be installed again. */
export const BUILD_GONE = {
  unrecorded: "Appflare has no record of the build this install was made from.",
  noSandbox:
    "Sandbox builds are off, so Appflare cannot read this build. Turning them off deletes every build.",
  missing: "The build's files are no longer in the sandbox Worker's bucket.",
  unknown:
    "The sandbox Worker did not answer, so Appflare could not check that the build is still there. Reload the page to try again.",
} as const;

/**
 * Whether a build's files are in the sandbox Worker's bucket: `no-sandbox`
 * when Appflare is not connected to sandbox builds. Throws when the sandbox
 * Worker did not answer.
 */
export type BuildFilesCheck = (keys: string[]) => Promise<"present" | "missing" | "no-sandbox">;

/** {@link BuildFilesCheck} through the `SANDBOX` binding: a HEAD request per file. */
export function sandboxBuildFiles(env: { SANDBOX?: unknown }): BuildFilesCheck {
  return async (keys) => {
    if (env.SANDBOX === undefined) return "no-sandbox";
    const read = sandboxFetch(env);
    for (const key of keys) {
      const response = await read(sandboxObjectUrl(key), { method: "HEAD" });
      if (response.status === 404) return "missing";
      if (!response.ok) throw new Error(`the sandbox Worker answered HTTP ${response.status}`);
    }
    return "present";
  };
}

type Refusal = { ok: false; refusal: string };

/**
 * The failed install `installId`, when it can be installed again; `app`
 * (the app the new install is of) must be its own: a catalog app's for the
 * catalog's form, or, with `fromBuild`, the app of the build the form
 * installs (its catalog id null for a repository).
 */
export async function readReplacedInstall(
  d1: D1Database,
  installId: string,
  app?:
    | { slug: string; catalogId: string }
    | { slug: string; catalogId: string | null; fromBuild: true },
): Promise<{ ok: true; install: ReplacedInstall } | Refusal> {
  const db = createDb(d1);
  const [row] = await db.select().from(installs).where(eq(installs.id, installId)).limit(1);
  if (row === undefined) return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.missing };
  if (row.status !== "failed") return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.notFailed };
  if (app !== undefined) {
    const fromBuild = "fromBuild" in app;
    if (fromBuild && row.origin === "catalog") {
      return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.fromCatalog };
    }
    if (!fromBuild && row.origin !== "catalog") {
      return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.notCatalog };
    }
    // A build records the catalog of the app it is of exactly as its install does.
    const sameCatalog = fromBuild
      ? row.catalog_id === app.catalogId
      : (row.catalog_id ?? OFFICIAL_CATALOG_ID) === app.catalogId;
    if (row.app_slug !== app.slug || !sameCatalog) {
      return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.otherApp };
    }
  }
  const [active, live, [installJob]] = await Promise.all([
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.install_id, installId), inArray(jobs.status, ["queued", "running"])))
      .limit(1),
    db
      .select({ id: resources.id, kind: resources.kind, name: resources.name })
      .from(resources)
      .where(
        and(
          eq(resources.install_id, installId),
          isNull(resources.deleted_at),
          isNull(resources.retained_at),
        ),
      ),
    // Not from the catalog: the build it was installed from, which its install job recorded.
    row.origin === "catalog"
      ? Promise.resolve([])
      : db
          .select({ input: jobs.input_json })
          .from(jobs)
          .where(and(eq(jobs.install_id, installId), eq(jobs.kind, "install")))
          .orderBy(desc(jobs.id))
          .limit(1),
  ]);
  if (active.length > 0) return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.busy };
  // Secrets go with the Worker: what the admin sees, and what needs a removal.
  const leftovers = live
    .filter((r) => r.kind !== "secret")
    .map((r) => ({ kind: r.kind, name: r.name }));
  return {
    ok: true,
    install: {
      id: row.id,
      workerName: row.worker_name,
      buildKind: row.build_kind,
      version: row.catalog_version,
      origin: row.origin,
      artifactUrl: row.artifact_url,
      buildId: buildIdOfInput(installJob?.input ?? null),
      hasLeftovers: leftovers.length > 0,
      dataResourceIds: live.filter((r) => isDataResourceKind(r.kind)).map((r) => r.id),
      workerNames: live.filter((r) => r.kind === "worker").map((r) => r.name),
      leftovers,
    },
  };
}

/**
 * For a build's install form: the failed install `installId` it replaces,
 * which must be of the build's app, and whether the form installs the build
 * that install was made from (`reused`), which must still be in the bucket.
 */
export async function readReplacedBySource(
  d1: D1Database,
  installId: string,
  build: {
    id: string;
    app: { slug: string; catalogId: string | null };
    /** Its manifest's and zip's object keys; null until built. */
    keys: [string | null, string | null];
    buildFiles?: BuildFilesCheck;
  },
): Promise<{ ok: true; install: ReplacedInstall; reused: boolean } | Refusal> {
  const read = await readReplacedInstall(d1, installId, { ...build.app, fromBuild: true });
  if (!read.ok) return read;
  const install = read.install;
  if (install.buildId !== build.id) return { ok: true, install, reused: false };
  const [manifestKey, artifactKey] = build.keys;
  if (
    manifestKey === null ||
    artifactKey === null ||
    sandboxObjectUrl(artifactKey) !== install.artifactUrl
  ) {
    return { ok: false, refusal: `${BUILD_GONE.unrecorded} ${BUILD_AGAIN}` };
  }
  if (build.buildFiles !== undefined) {
    let files: Awaited<ReturnType<BuildFilesCheck>>;
    try {
      files = await build.buildFiles([manifestKey, artifactKey]);
    } catch {
      return { ok: false, refusal: BUILD_GONE.unknown };
    }
    if (files !== "present") {
      const why = files === "no-sandbox" ? BUILD_GONE.noSandbox : BUILD_GONE.missing;
      return { ok: false, refusal: `${why} ${BUILD_AGAIN}` };
    }
  }
  return { ok: true, install, reused: true };
}

/** After a refusal of a build that is gone: where to go on. */
const BUILD_AGAIN = "Reload the page to build it again.";

/**
 * "Install again" of a failed install from a repository whose build is gone:
 * the build request that builds the same repository at the same branch, tag
 * or commit again, with the build command its build used. Its review then
 * opens the install form filled in from the failed install.
 */
export async function installAgainBuildRequest(
  d1: D1Database,
  installId: string,
): Promise<{ ok: true; request: Exclude<StartSourceBuildRequest, { kind: "rebuild" }> } | Refusal> {
  const read = await readReplacedInstall(d1, installId);
  if (!read.ok) return read;
  const db = createDb(d1);
  const [row] = await db.select().from(installs).where(eq(installs.id, installId)).limit(1);
  if (row === undefined) return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.missing };
  if (row.origin === "catalog") return { ok: false, refusal: INSTALL_AGAIN_REFUSALS.fromCatalog };
  const [build] =
    read.install.buildId === null
      ? []
      : await db
          .select({
            repo: source_builds.repo,
            ref: source_builds.ref,
            requestedRef: source_builds.requested_ref,
            command: source_builds.build_command_json,
          })
          .from(source_builds)
          .where(eq(source_builds.id, read.install.buildId))
          .limit(1);
  const repo = build?.repo ?? row.source_url?.replace(/^https:\/\/github\.com\//, "") ?? "";
  if (repo.length === 0) {
    return { ok: false, refusal: "This install does not record the repository it came from." };
  }
  const ref = row.source_ref ?? build?.ref ?? build?.requestedRef ?? undefined;
  const buildCommand = commandOf(build?.command ?? null);
  const common = {
    ...(ref === undefined ? {} : { ref }),
    ...(buildCommand === null ? {} : { buildCommand }),
    costConfirmed: false,
  };
  return {
    ok: true,
    request:
      row.origin === "source"
        ? { kind: "source", slug: installAppKey(row), ...common }
        : { kind: "repository", repository: repo, ...common },
  };
}

function commandOf(json: string | null): BuildCommandChoice | null {
  if (json === null) return null;
  try {
    const parsed = buildCommandChoiceSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What an install job recorded in `jobs.input_json` that the form takes again. */
const recordedChoices = z
  .object({
    vars: z.record(z.string(), z.string()).catch({}),
    access: z.boolean().catch(false),
    /** The app's name when the install started (it records its manifest only once it finishes). */
    appName: z.string().min(1).nullable().catch(null),
    domain: installDomainInput.nullable().catch(null),
    emailRouting: z
      .object({ zoneId: z.string() })
      .nullable()
      .catch(null)
      .transform((e) => e?.zoneId ?? null),
  })
  .partial();

function choicesOf(inputJson: string | null): z.infer<typeof recordedChoices> {
  if (inputJson === null) return {};
  try {
    const parsed = recordedChoices.safeParse(JSON.parse(inputJson));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function varsOf(configJson: string | null): Record<string, string> | null {
  if (configJson === null) return null;
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(configJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The "Install again" record of `installId`; null when there is no such
 * install. A record with a `refusal` says why it cannot be installed again
 * now; the page shows it in place of the form. For an install from a
 * repository, `buildFiles` checks the build it was made from is still in the
 * sandbox Worker's bucket; without it the build counts as there when its
 * record is.
 */
export async function readInstallAgain(
  d1: D1Database,
  installId: string,
  deps: { buildFiles?: BuildFilesCheck } = {},
): Promise<InstallAgainRecord | null> {
  const db = createDb(d1);
  const [row] = await db.select().from(installs).where(eq(installs.id, installId)).limit(1);
  if (row === undefined) return null;
  const [replaced, [job]] = await Promise.all([
    readReplacedInstall(d1, installId),
    db
      .select({ id: jobs.id, input: jobs.input_json })
      .from(jobs)
      .where(and(eq(jobs.install_id, installId), eq(jobs.kind, "install")))
      .orderBy(desc(jobs.id))
      .limit(1),
  ]);
  const choices = choicesOf(job?.input ?? null);
  const install = replaced.ok ? replaced.install : null;
  return {
    installId: row.id,
    appKey: installAppKey(row),
    label: installLabel(namedInstall({ ...row, app_name: choices.appName ?? null })),
    version: row.catalog_version,
    workerName: row.worker_name,
    displayName: row.display_name,
    // As stored on the install; the job's copy for an install that never got that far.
    vars: varsOf(row.config_json) ?? choices.vars ?? {},
    access: choices.access ?? false,
    domain: choices.domain ?? null,
    emailZoneId: choices.emailRouting ?? null,
    autoUpdate: row.auto_update,
    leftovers: install?.leftovers ?? [],
    failedJobId: job?.id ?? null,
    refusal: replaced.ok ? null : replaced.refusal,
    origin: row.origin,
    source:
      row.origin === "catalog"
        ? null
        : await sourceOf(
            d1,
            row,
            buildIdOfInput(job?.input ?? null),
            // The bucket is asked only when the build may be installed again.
            replaced.ok ? deps.buildFiles : undefined,
          ),
  };
}

/** The build an install from a repository was made from, and whether it can be installed again. */
async function sourceOf(
  d1: D1Database,
  row: typeof installs.$inferSelect,
  buildId: string | null,
  buildFiles: BuildFilesCheck | undefined,
): Promise<InstallAgainSource> {
  const [build] =
    buildId === null
      ? []
      : await createDb(d1)
          .select()
          .from(source_builds)
          .where(eq(source_builds.id, buildId))
          .limit(1);
  const recordedRepo = row.source_url?.replace(/^https:\/\/github\.com\//, "") ?? "";
  const base = {
    origin: row.origin === "source" ? ("source" as const) : ("repository" as const),
    repo: build?.repo ?? recordedRepo,
    ref: row.source_ref ?? build?.ref ?? build?.requested_ref ?? null,
    commit: row.pin_sha ?? build?.commit_sha ?? null,
    buildId: build?.id ?? null,
  };
  // Its own build: taken by its install, and the artifact it was installing.
  if (
    build === undefined ||
    build.status !== "used" ||
    build.manifest_key === null ||
    build.artifact_key === null ||
    sandboxObjectUrl(build.artifact_key) !== row.artifact_url
  ) {
    return {
      ...base,
      build: { state: "gone", cause: "unrecorded", reason: BUILD_GONE.unrecorded },
    };
  }
  if (buildFiles === undefined) return { ...base, build: { state: "ready" } };
  try {
    const files = await buildFiles([build.manifest_key, build.artifact_key]);
    if (files === "present") return { ...base, build: { state: "ready" } };
    return {
      ...base,
      build:
        files === "no-sandbox"
          ? { state: "gone", cause: "no-sandbox", reason: BUILD_GONE.noSandbox }
          : { state: "gone", cause: "missing", reason: BUILD_GONE.missing },
    };
  } catch {
    return { ...base, build: { state: "unknown", reason: BUILD_GONE.unknown } };
  }
}

/**
 * Starting an install that replaces a failed one, as both install forms do
 * (the catalog's, and a build's review): the removal of what the failed
 * install left, when it left anything, as an uninstall job that keeps
 * nothing; null when it left nothing.
 */
export function removalOf(
  replaced: ReplacedInstall,
  installId: string,
  newId: () => string,
): ReturnType<typeof uninstallJob> | null {
  if (!replaced.hasLeftovers) return null;
  return uninstallJob(replaced, {
    jobId: newId(),
    installId: replaced.id,
    deleteResources: replaced.dataResourceIds,
    retry: false,
    replacedBy: installId,
  });
}

/**
 * The claim's statements for "Install again", after the new install's own:
 * each applies only if the new install row was inserted. With something
 * left in the account, the failed install's removal job is recorded and the
 * install becomes `uninstalling`, as an uninstall that keeps nothing; with
 * nothing left, the failed install is retired to `uninstalled` at once.
 */
export function replaceStatements(
  db: D1Database,
  replaced: ReplacedInstall,
  installId: string,
  cleanup: ReturnType<typeof uninstallJob> | null,
  now: Date,
): D1PreparedStatement[] {
  const at = now.getTime();
  if (cleanup === null) {
    // Nothing left but secret records, which went with its Worker.
    return [
      db
        .prepare(
          `UPDATE installs SET status = 'uninstalled', uninstalled_at = ?3, updated_at = ?3
           WHERE id = ?1 AND status = 'failed'
             AND EXISTS (SELECT 1 FROM installs WHERE id = ?2)
             AND NOT EXISTS (
               SELECT 1 FROM resources r
               WHERE r.install_id = ?1 AND r.deleted_at IS NULL AND r.kind != 'secret'
             )`,
        )
        .bind(replaced.id, installId, at),
      db
        .prepare(
          `UPDATE resources SET deleted_at = ?3
           WHERE install_id = ?1 AND deleted_at IS NULL AND kind = 'secret'
             AND EXISTS (SELECT 1 FROM installs WHERE id = ?1 AND status = 'uninstalled')
             AND EXISTS (SELECT 1 FROM installs WHERE id = ?2)`,
        )
        .bind(replaced.id, installId, at),
    ];
  }
  return [
    db
      .prepare(
        `INSERT INTO jobs (id, install_id, kind, status, input_json)
         SELECT ?1, ?2, 'uninstall', 'queued', ?3
         WHERE EXISTS (SELECT 1 FROM installs WHERE id = ?4)
           AND EXISTS (SELECT 1 FROM installs WHERE id = ?2 AND status = 'failed')`,
      )
      .bind(cleanup.params.jobId, replaced.id, cleanup.inputJson, installId),
    db
      .prepare(
        `UPDATE installs SET status = 'uninstalling', updated_at = ?3
         WHERE id = ?2 AND EXISTS (SELECT 1 FROM jobs WHERE id = ?1)`,
      )
      .bind(cleanup.params.jobId, replaced.id, at),
  ];
}

/**
 * Starts the removal claimed by {@link replaceStatements}, before the new
 * install's job, which waits for it. When it cannot start, both jobs are
 * recorded as failed and the new install too, and the reason is thrown: the
 * failed install stays `uninstalling`, so its page offers to finish
 * uninstalling it, and nothing of the new install exists in the account.
 */
export async function launchRemoval(
  deps: {
    db: D1Database;
    createJob(
      id: string,
      params: ReturnType<typeof uninstallJob>["params"],
    ): Promise<{ id: string }>;
  },
  cleanup: ReturnType<typeof uninstallJob>,
  next: { jobId: string; installId: string },
  now: Date,
): Promise<void> {
  const db = createDb(deps.db);
  try {
    const removal = await deps.createJob(cleanup.params.jobId, cleanup.params);
    await db
      .update(jobs)
      .set({ workflow_instance_id: removal.id })
      .where(eq(jobs.id, cleanup.params.jobId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `start: could not start removing the install that did not finish: ${message}`;
    await db
      .update(jobs)
      .set({ status: "failed", error: reason, finished_at: now })
      .where(inArray(jobs.id, [cleanup.params.jobId, next.jobId]));
    await db
      .update(installs)
      .set({ status: "failed", updated_at: now })
      .where(eq(installs.id, next.installId));
    throw new Error(reason);
  }
}
