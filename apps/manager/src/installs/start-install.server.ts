import type { ArtifactManifest, IndexApp } from "@appflare/schema";
import { and, eq, ne, or } from "drizzle-orm";
import { ulid } from "ulidx";
import { createDb } from "../db/client";
import { installs, jobs } from "../db/schema";
import type { InstallJobParams } from "../jobs/install";
import type { StartInstallInput } from "./install-input";

/**
 * Starting an install: validate the form against the
 * signed catalog manifest, claim the Worker name and the app (one instance per
 * app), record `installs` + `jobs`, then create the `JobWorkflow`
 * instance. Secret VALUES go only into the Workflow params, which Workflows
 * stores encrypted at rest; `jobs.input_json` keeps their names.
 */

export class StartInstallError extends Error {
  override name = "StartInstallError";
}

export interface CatalogEntry {
  app: IndexApp;
  manifest: ArtifactManifest;
}

export interface StartInstallDeps {
  db: D1Database;
  /** The index entry and its verified manifest; throws `StartInstallError` when unavailable. */
  loadApp(slug: string): Promise<CatalogEntry>;
  /** Creates the Workflow instance (`env.JOBS.create`). */
  createJob(id: string, params: InstallJobParams): Promise<{ id: string }>;
  now?: () => Date;
  newId?: () => string;
}

export interface StartInstallResult {
  jobId: string;
  installId: string;
}

export interface ResolvedInstallInput {
  secrets: Record<string, string>;
  vars: Record<string, string>;
}

/**
 * Checks the form against the signed catalog manifest. Names the manifest does
 * not declare are rejected, not dropped. Every secret needs a value: the form
 * prefills `generate: true` secrets, so an empty one means a broken client.
 */
export function resolveInstallInput(
  manifest: ArtifactManifest,
  input: StartInstallInput,
): ResolvedInstallInput {
  const catalog = manifest.catalog;
  if (catalog.plan === "paid" && !input.paidConfirmed) {
    throw new StartInstallError(
      `${catalog.name} needs Workers Paid. Confirm that this account is on Workers Paid.`,
    );
  }
  const declaredSecrets = new Set(catalog.secrets.map((s) => s.name));
  const declaredVars = new Set(catalog.vars.map((v) => v.name));
  const unknown = [
    ...Object.keys(input.secrets).filter((name) => !declaredSecrets.has(name)),
    ...Object.keys(input.vars).filter((name) => !declaredVars.has(name)),
  ];
  if (unknown.length > 0) {
    throw new StartInstallError(`${catalog.name} does not take: ${unknown.join(", ")}.`);
  }
  const secrets: Record<string, string> = {};
  for (const secret of catalog.secrets) {
    const value = input.secrets[secret.name] ?? "";
    if (value.length === 0) {
      throw new StartInstallError(`${secret.label} (${secret.name}) is required.`);
    }
    secrets[secret.name] = value;
  }
  const vars: Record<string, string> = {};
  for (const v of catalog.vars) {
    const value = (input.vars[v.name] ?? "").trim();
    if (value.length > 0) vars[v.name] = value;
    else if (v.required && v.default === undefined) {
      throw new StartInstallError(`${v.label} (${v.name}) is required.`);
    }
  }
  return { secrets, vars };
}

export async function startInstallCore(
  deps: StartInstallDeps,
  input: StartInstallInput,
): Promise<StartInstallResult> {
  const { app, manifest } = await deps.loadApp(input.slug);
  const resolved = resolveInstallInput(manifest, input);
  const now = (deps.now ?? (() => new Date()))();
  const newId = deps.newId ?? (() => ulid());
  const installId = newId();
  const jobId = newId();
  const db = createDb(deps.db);

  // One D1 batch (a transaction), so no partial state is ever left behind:
  // 1. A `failed` install that holds no live resources is retired to
  //    `uninstalled`, so the same app or Worker name can be installed again.
  //    A failed install that still owns resources keeps blocking (uninstall it
  //    first).
  // 2. The new install claims the Worker name and the app only if no other
  //    active install uses either (one instance per app), so two
  //    concurrent starts cannot both win.
  // 3. The job row is inserted only if the install row was.
  const inputJson = JSON.stringify({
    slug: app.slug,
    version: app.version,
    workerName: input.workerName,
    secrets: Object.keys(resolved.secrets),
    vars: resolved.vars,
    paidConfirmed: input.paidConfirmed,
  });
  const [, claimed] = await deps.db.batch([
    deps.db
      .prepare(
        `UPDATE installs SET status = 'uninstalled', updated_at = ?3
         WHERE status = 'failed' AND (worker_name = ?1 OR app_slug = ?2)
           AND NOT EXISTS (
             SELECT 1 FROM resources r WHERE r.install_id = installs.id AND r.deleted_at IS NULL
           )`,
      )
      .bind(input.workerName, app.slug, now.getTime()),
    deps.db
      .prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
           artifact_url, artifact_digest, pin_sha, status, config_json, installed_at, updated_at)
         SELECT ?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, 'installing', ?8, ?9, ?9
         WHERE NOT EXISTS (
           SELECT 1 FROM installs
           WHERE status != 'uninstalled' AND (worker_name = ?3 OR app_slug = ?2)
         )`,
      )
      .bind(
        installId,
        app.slug,
        input.workerName,
        app.version,
        app.artifacts.zip,
        app.digest,
        manifest.source.sha,
        JSON.stringify(resolved.vars),
        now.getTime(),
      ),
    deps.db
      .prepare(
        `INSERT INTO jobs (id, install_id, kind, status, input_json)
         SELECT ?1, ?2, 'install', 'queued', ?3
         WHERE EXISTS (SELECT 1 FROM installs WHERE id = ?2)`,
      )
      .bind(jobId, installId, inputJson),
  ]);
  if (claimed?.meta.changes !== 1) {
    const [clash] = await db
      .select({ status: installs.status, worker: installs.worker_name })
      .from(installs)
      .where(
        and(
          ne(installs.status, "uninstalled"),
          or(eq(installs.worker_name, input.workerName), eq(installs.app_slug, app.slug)),
        ),
      )
      .limit(1);
    if (clash?.status === "failed") {
      throw new StartInstallError(
        `A failed install of ${clash.worker === input.workerName ? `the Worker "${input.workerName}"` : manifest.catalog.name} still owns resources in this account. Uninstall it first.`,
      );
    }
    throw new StartInstallError(
      clash?.worker === input.workerName
        ? `Another install already uses the Worker name "${input.workerName}".`
        : `${manifest.catalog.name} is already installed. Appflare installs one instance per app.`,
    );
  }

  const params: InstallJobParams = {
    kind: "install",
    jobId,
    installId,
    slug: app.slug,
    version: app.version,
    workerName: input.workerName,
    artifacts: app.artifacts,
    digest: app.digest,
    secrets: resolved.secrets,
    vars: resolved.vars,
    paidConfirmed: input.paidConfirmed,
  };
  let instanceId: string;
  try {
    instanceId = (await deps.createJob(jobId, params)).id;
  } catch (error) {
    const reason = `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await db
      .update(jobs)
      .set({ status: "failed", error: reason, finished_at: now })
      .where(eq(jobs.id, jobId));
    await db
      .update(installs)
      .set({ status: "failed", updated_at: now })
      .where(eq(installs.id, installId));
    throw new StartInstallError(reason);
  }
  await db.update(jobs).set({ workflow_instance_id: instanceId }).where(eq(jobs.id, jobId));
  return { jobId, installId };
}
