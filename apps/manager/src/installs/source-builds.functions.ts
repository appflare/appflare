import { env } from "cloudflare:workers";
import {
  type CatalogManifest,
  type CatalogSecret,
  catalogWorkerName,
  type RepositoryDetection,
  repositoryUrl,
} from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { AccountPlan } from "../account/plan";
import { hasRole } from "../auth/roles";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { readCapabilitiesView } from "../capabilities/capabilities.server";
import { getAppManifest, getCatalogManifest } from "../catalog/app-manifest.server";
import { findCatalogApp } from "../catalog/merged.server";
import type { AppPrimitives } from "../catalog/primitives";
import { type RequirementChecks, requirementChecks } from "../catalog/requirement-checks";
import { parseAppKey } from "../catalog/sources";
import { getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { type InstallOrigin, installs, jobs, type SourceBuildStatus } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { readRepositoryRefs, repositoryReader } from "../github/access.server";
import { reconcileJobs } from "../jobs/reconcile.server";
import { sandboxAutoEnableDeps } from "../sandbox/auto-enable-env.server";
import { sandboxBinding, sandboxInfo } from "../sandbox/binding";
import { requireRole, requireSession } from "../server/auth.server";
import { installLabel } from "./display-name";
import { type InstallVarField, installVarFields } from "./install-vars";
import { suggestWorkerName } from "./instance-names";
import {
  installSourceBuildInput,
  sourceBuildIdInput,
  startSourceBuildInput,
  updateFromSourceBuildInput,
} from "./source-build-input";
import {
  checkSourceChangesCore,
  discardSourceBuildCore,
  effectiveStatus,
  installSourceBuildCore,
  readSourceBuild,
  SourceBuildError,
  type SourceChanges,
  sourceUpdateNeeds,
  startSourceBuildCore,
  updateFromSourceBuildCore,
} from "./source-builds.server";
import { bindingChanges, reviewBuild } from "./source-review";
import { VersionActionError } from "./versions.server";

/**
 * Builds from a repository and from source (admins start, install, update
 * and discard; everyone signed in can read a build's review), and "Check for
 * changes" for installs that came from a repository.
 */

function asUserError(error: unknown): never {
  if (error instanceof SourceBuildError || error instanceof VersionActionError) {
    throw new Error(error.message);
  }
  throw error;
}

async function sandboxState() {
  const binding = sandboxBinding(env);
  if (binding === undefined) return { connected: false, info: null };
  try {
    return { connected: true, info: await sandboxInfo(binding) };
  } catch {
    return { connected: true, info: null };
  }
}

/** The app an app key names, with its catalog manifest verified with its own catalog's keys. */
async function loadCatalogApp(key: string) {
  const read = await findCatalogApp(env, key);
  if (!read.ok) throw new SourceBuildError(read.error);
  if (read.listed === null) throw new SourceBuildError(`"${key}" is not in the catalog.`);
  const manifest = await getCatalogManifest(env, read.listed.app, read.listed.trust);
  if (!manifest.ok) throw new SourceBuildError(manifest.error);
  return { app: read.listed.app, catalog: manifest.catalog };
}

/** Public repositories directly; private ones with the GitHub access tokens, through the sandbox Worker. */
const listRefs = (repo: string) => readRepositoryRefs(repositoryReader(env), repo);

/**
 * Admin only: starts a build for review, of a repository, of a catalog app
 * from source, or of an install from a repository at its branch's newest
 * commit. Returns the build's id (also its job's) for `/jobs/$jobId`.
 */
export const startSourceBuild = createServerFn({ method: "POST" })
  .validator(startSourceBuildInput)
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    await requireRole("admin");
    try {
      return await startSourceBuildCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          createJob: (id, params) => env.JOBS.create({ id, params }),
          sandbox: sandboxState,
          autoEnable: sandboxAutoEnableDeps(env),
          listRefs,
          loadCatalogApp,
        },
        data,
      );
    } catch (error) {
      asUserError(error);
    }
  });

/** What the review shows about a finished build. */
export interface SourceBuildReview {
  catalog: CatalogManifest;
  varFields: InstallVarField[];
  creates: Array<{ kind: string; binding: string }>;
  durableObjects: string[];
  workflows: string[];
  bindings: Array<{ type: string; name: string }>;
  crons: string[];
  primitives: AppPrimitives;
  requires: string[];
  checks: RequirementChecks;
  /** Why installing or updating would be refused; empty when it would not. */
  problems: string[];
  /** For a catalog app built from source: how its bindings differ from the catalog's release. */
  baseline: { added: string[]; removed: string[] } | null;
  /** For an update: secrets the build introduces, and why no preview check is possible. */
  needsSecrets: CatalogSecret[];
  /** Names among `needsSecrets` the Worker already has; their fields start empty. */
  heldSecrets: string[];
  skipsPreview: string | null;
  suggestedWorkerName: string;
  subdomain: string | null;
  accountPlan: AccountPlan;
  planDetected: boolean;
  capabilities: CapabilitiesView;
}

export interface SourceBuildView {
  id: string;
  status: SourceBuildStatus;
  /** The job's error when the build failed. */
  error: string | null;
  purpose: "install" | "update";
  origin: Exclude<InstallOrigin, "catalog">;
  repo: string;
  repoUrl: string;
  /** What was asked for; null for the default branch. */
  requestedRef: string | null;
  /** Set once built. */
  ref: string | null;
  commit: string | null;
  version: string | null;
  image: string | null;
  builtAt: string | null;
  detected: RepositoryDetection | null;
  /** For a catalog app built from source. */
  app: { slug: string; name: string } | null;
  /** The install being updated, or the one made from this build once installed. */
  install: {
    id: string;
    label: string;
    workerName: string;
    version: string;
    commit: string | null;
    status: string;
  } | null;
  review: SourceBuildReview | null;
}

/** Worker names that are taken: active installs', and (for admins) the account's. */
async function takenWorkerNames(admin: boolean): Promise<string[]> {
  const rows = await createDb(env.DB)
    .select({ worker: installs.worker_name })
    .from(installs)
    .where(ne(installs.status, "uninstalled"));
  let account: string[] = [];
  if (admin) {
    try {
      account = (await (await getCfClient(env)).workers.listScripts()).map((s) => s.id);
    } catch {
      account = [];
    }
  }
  return [...rows.map((r) => r.worker), ...account];
}

/** Any signed-in user: a build and, once built, its review. Null when there is no such build. */
export const getSourceBuild = createServerFn({ method: "GET" })
  .validator(sourceBuildIdInput)
  .handler(async ({ data }): Promise<SourceBuildView | null> => {
    const session = await requireSession();
    const admin = hasRole(session.user.role, "admin");
    const orm = createDb(env.DB);
    const active = await orm
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, data.buildId), inArray(jobs.status, ["queued", "running"])));
    if (active.length > 0) await reconcileJobs(env.DB, env.JOBS, active);
    const record = await readSourceBuild(env.DB, data.buildId);
    if (record === null) return null;
    const { row, manifest, detected } = record;
    const status = effectiveStatus(record);
    const [install] = await orm
      .select()
      .from(installs)
      .where(eq(installs.id, row.install_id))
      .limit(1);
    let app: SourceBuildView["app"] = null;
    let release: Awaited<ReturnType<typeof getAppManifest>> | null = null;
    if (row.app_slug !== null) {
      // A build from source records its app key (`<catalog>:<slug>` for a custom catalog).
      const read = await findCatalogApp(env, row.app_slug);
      const found = read.ok ? read.listed : null;
      const listed = found?.app ?? null;
      app = { slug: row.app_slug, name: listed?.name ?? parseAppKey(row.app_slug).slug };
      if (found !== null && listed?.tier === "artifact") {
        release = await getAppManifest(env, listed, found.trust);
      }
    }
    let review: SourceBuildReview | null = null;
    if (manifest !== null && (status === "built" || status === "used")) {
      const capabilities = await readCapabilitiesView(orm);
      const settings = await readSettings(orm, [SETTING.accountSubdomain]);
      const updating = row.purpose === "update" && install !== undefined;
      const suggested = updating
        ? install.worker_name
        : suggestWorkerName(
            catalogWorkerName(manifest.catalog),
            status === "built" ? await takenWorkerNames(admin) : [],
          );
      const facts = reviewBuild(
        manifest,
        detected,
        suggested,
        row.origin === "source" ? "source" : "repository",
      );
      const needs = updating
        ? await sourceUpdateNeeds(env.DB, install, manifest)
        : { needsSecrets: [], skipsPreview: null };
      review = {
        catalog: manifest.catalog,
        varFields: installVarFields(manifest),
        creates: facts.creates,
        durableObjects: facts.durableObjects,
        workflows: facts.workflows,
        bindings: facts.bindings,
        crons: facts.crons,
        primitives: {
          ids: facts.services as AppPrimitives["ids"],
          keyValueDurableObjects: false,
          complete: true,
        },
        requires: facts.requires,
        checks: requirementChecks(
          { plan: manifest.catalog.plan, requires: facts.requires },
          capabilities,
        ),
        problems: facts.problems,
        baseline: release?.ok === true ? bindingChanges(release.manifest, manifest) : null,
        needsSecrets: needs.needsSecrets,
        heldSecrets: needs.heldSecrets ?? [],
        skipsPreview: needs.skipsPreview,
        suggestedWorkerName: suggested,
        subdomain: settings.account_subdomain || null,
        accountPlan: capabilities.plan.plan,
        planDetected: capabilities.plan.source === "detected",
        capabilities,
      };
    }
    return {
      id: row.id,
      status,
      error: status === "failed" ? (record.job?.error ?? null) : null,
      purpose: row.purpose,
      origin: row.origin === "source" ? "source" : "repository",
      repo: row.repo,
      repoUrl: repositoryUrl(row.repo),
      requestedRef: row.requested_ref,
      ref: row.ref,
      commit: row.commit_sha,
      version: row.version,
      image: row.image,
      builtAt: row.built_at?.toISOString() ?? null,
      detected,
      app,
      install:
        install === undefined
          ? null
          : {
              id: install.id,
              label: installLabel({
                displayName: install.display_name,
                workerName: install.worker_name,
              }),
              workerName: install.worker_name,
              version: install.catalog_version,
              commit: install.pin_sha,
              status: install.status,
            },
      review,
    };
  });

/** Admin only: installs a reviewed build. Returns the install job's id. */
export const installSourceBuild = createServerFn({ method: "POST" })
  .validator(installSourceBuildInput)
  .handler(async ({ data }): Promise<{ jobId: string; installId: string }> => {
    await requireRole("admin");
    try {
      return await installSourceBuildCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          createJob: (id, params) => env.JOBS.create({ id, params }),
          async listAccountWorkers() {
            return (await (await getCfClient(env)).workers.listScripts()).map((s) => s.id);
          },
        },
        data,
      );
    } catch (error) {
      asUserError(error);
    }
  });

/** Admin only: updates the install from its reviewed rebuild. Returns the update job's id. */
export const updateFromSourceBuild = createServerFn({ method: "POST" })
  .validator(updateFromSourceBuildInput)
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    await requireRole("admin");
    try {
      return await updateFromSourceBuildCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          createJob: (id, params) => env.JOBS.create({ id, params }),
        },
        data,
      );
    } catch (error) {
      asUserError(error);
    }
  });

/** Admin only: throws a build away and deletes its objects from the sandbox Worker's bucket. */
export const discardSourceBuild = createServerFn({ method: "POST" })
  .validator(sourceBuildIdInput)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireRole("admin");
    const binding = sandboxBinding(env);
    try {
      await discardSourceBuildCore(
        {
          db: env.DB,
          ...(binding === undefined
            ? {}
            : {
                cleanup: async (installId, keepVersions) => {
                  await binding.cleanup({ installId, keepVersions });
                },
              }),
        },
        data.buildId,
      );
      return { ok: true };
    } catch (error) {
      asUserError(error);
    }
  });

/** Admin only: the newest commit at the branch or tag an install from a repository follows. */
export const checkSourceChanges = createServerFn({ method: "POST" })
  .validator(z.object({ installId: z.string().min(1).max(64) }))
  .handler(async ({ data }): Promise<SourceChanges> => {
    await requireRole("admin");
    try {
      return await checkSourceChangesCore({ db: env.DB, listRefs }, data.installId);
    } catch (error) {
      asUserError(error);
    }
  });
