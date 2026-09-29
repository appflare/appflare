import type { ArtifactAssets } from "./artifact";
import type { CatalogSecret, CatalogVar } from "./catalog";

/**
 * Workers that are static assets and nothing else: a wrangler config with
 * `assets` and no `main`. Wrangler 4.136.2 uploads such a Worker without a
 * single module part (`createWorkerUploadForm` returns early when the assets
 * router has no user Worker): its metadata is only `assets: { jwt, config }`,
 * `compatibility_date`, `compatibility_flags` and, for a version,
 * `annotations`. Bindings, migrations and every other setting are not sent.
 *
 * The artifact records such a Worker with no modules and no `mainModule`.
 *
 * Imports only types, so `artifact.ts` can use it without a cycle at load time.
 */

/**
 * The `info().features` entry of a sandbox Worker whose packer and schema
 * take what came with Workers of static assets only: a wrangler config
 * without `main`, an empty `install.installDirs` (a repository without a
 * `package.json`), and catalog secrets marked `multiline`. A sandbox Worker
 * without it refuses the first inside its packer and the second inside its
 * schema, and drops `multiline` from the catalog manifest it builds with, so
 * the manager refuses those entries up front and asks for a sandbox update.
 */
export const SANDBOX_FEATURE_ASSETS_ONLY = "assets-only";

/** Whether a Worker has no code of its own and serves its static assets only. */
export function isAssetsOnlyWorker(worker: { modules: readonly unknown[] }): boolean {
  return worker.modules.length === 0;
}

/** What of a Worker decides whether it can be an assets-only Worker. */
export interface AssetsOnlyWorkerFacts {
  mainModule?: string | undefined;
  modules: readonly unknown[];
  bindings: ReadonlyArray<{ type: string; name: string }>;
  migrations: readonly unknown[];
  crons: readonly string[];
  queueConsumers?: readonly unknown[] | undefined;
  exports?: Readonly<Record<string, unknown>> | undefined;
  cacheOptions?: unknown;
  observability?: unknown;
  placement?: unknown;
  limits?: unknown;
}

/** The catalog secrets and vars that go to the Worker (its view of the catalog manifest). */
export interface AssetsOnlyCatalogFacts {
  secrets: ReadonlyArray<Pick<CatalogSecret, "name" | "seedOnly">>;
  vars: ReadonlyArray<Pick<CatalogVar, "name" | "seedOnly">>;
}

/**
 * What stops a Worker from being uploaded as it is recorded, as sentences;
 * empty when nothing does. A Worker with a main module must carry it among
 * its modules. A Worker without one (assets-only) must have static assets and
 * nothing that needs code to use it: no bindings (vars included), no catalog
 * secrets or vars, no Durable Object migrations or exports, no cron triggers
 * or queue consumers, no assets binding and no `run_worker_first` (wrangler
 * refuses those two itself). Observability, placement, limits and the cache
 * block are not recorded for it, since wrangler does not send them.
 *
 * `subject` names the Worker ("The Worker", `The Worker "api"`).
 */
export function assetsOnlyWorkerProblems(
  worker: AssetsOnlyWorkerFacts,
  /** Without `files`, the check that it has any is left out (a packer checks before collecting them). */
  assets: Pick<ArtifactAssets, "binding" | "config"> & { files?: readonly unknown[] | undefined },
  catalog: AssetsOnlyCatalogFacts,
  subject = "The Worker",
): string[] {
  if (worker.mainModule !== undefined) {
    return worker.modules.length === 0
      ? [`${subject} names the main module ${worker.mainModule} but has no modules.`]
      : [];
  }
  if (worker.modules.length > 0) {
    return [`${subject} has modules but no main module.`];
  }
  const problems: string[] = [];
  const why = "it has no code of its own (its wrangler config has assets and no main)";
  if (assets.files !== undefined && assets.files.length === 0) {
    problems.push(`${subject} has no code and no static assets, so it would serve nothing.`);
  }
  const needsCode: string[] = [];
  const names = (list: ReadonlyArray<{ name: string }>) => list.map((b) => b.name).join(", ");
  if (worker.bindings.length > 0) needsCode.push(`bindings (${names(worker.bindings)})`);
  const secrets = catalog.secrets.filter((s) => s.seedOnly !== true);
  if (secrets.length > 0) needsCode.push(`catalog secrets (${names(secrets)})`);
  const vars = catalog.vars.filter((v) => v.seedOnly !== true);
  if (vars.length > 0) needsCode.push(`catalog vars (${names(vars)})`);
  if (worker.migrations.length > 0) needsCode.push("Durable Object migrations");
  if (worker.exports !== undefined && Object.keys(worker.exports).length > 0) {
    needsCode.push("exports");
  }
  if (worker.crons.length > 0) needsCode.push("cron triggers");
  if ((worker.queueConsumers ?? []).length > 0) needsCode.push("queue consumers");
  if (assets.binding !== null) needsCode.push(`an assets binding (${assets.binding})`);
  const first = assets.config.run_worker_first;
  if (first === true || Array.isArray(first)) needsCode.push("assets.run_worker_first");
  if (needsCode.length > 0) {
    problems.push(
      `${subject} has ${needsCode.join(", ")}, but ${why}, so nothing could use them; ` +
        "give it a main entrypoint or leave them out.",
    );
  }
  const unsent: string[] = [];
  if (worker.observability != null) unsent.push("observability");
  if (worker.placement != null) unsent.push("placement");
  if (worker.limits != null) unsent.push("limits");
  if (worker.cacheOptions !== undefined) unsent.push("cacheOptions");
  if (unsent.length > 0) {
    problems.push(
      `${subject} records ${unsent.join(", ")}, but ${why}, and such a Worker is uploaded without them.`,
    );
  }
  return problems;
}
