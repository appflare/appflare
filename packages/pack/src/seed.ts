import {
  type CatalogManifest,
  isSeedOnly,
  manifestSeeds,
  type WorkerBinding,
} from "@appflare/schema";

/**
 * The packer's side of D1 seed statements (`resources.d1[binding].seed`).
 * The catalog manifest's schema already checks each statement (one guarded
 * INSERT, one param per `?`) and that every param names a declared var,
 * secret or hash. The pack adds what only the wrangler config can say: a
 * seed-only secret or var is never set on the Worker, so the app must not
 * expect it there.
 */

/**
 * Why the seed-only secrets and vars of `catalog` do not fit one Worker's
 * wrangler config, as sentences; empty when they do. `of` names the Worker
 * in messages (empty for an app of one Worker).
 */
export function seedOnlyConfigProblems(
  catalog: Pick<CatalogManifest, "secrets" | "vars">,
  config: { bindings: readonly WorkerBinding[]; requiredSecrets: readonly string[] },
  of: string,
): string[] {
  const problems: string[] = [];
  const seedOnlySecrets = new Set(catalog.secrets.filter(isSeedOnly).map((s) => s.name));
  for (const name of config.requiredSecrets) {
    if (seedOnlySecrets.has(name)) {
      problems.push(
        `the wrangler config${of} requires the secret ${name} (secrets.required), which the catalog manifest marks seedOnly; a seed-only secret is never set on the Worker, so drop seedOnly or the requirement`,
      );
    }
  }
  const configVars = new Set(
    config.bindings.filter((b) => b.type === "plain_text" || b.type === "json").map((b) => b.name),
  );
  for (const v of catalog.vars.filter(isSeedOnly)) {
    if (configVars.has(v.name)) {
      problems.push(
        `the wrangler config${of} declares the var ${v.name}, which the catalog manifest marks seedOnly; the Worker would get the config's value, never the one entered at install, so drop seedOnly or rename one of them`,
      );
    }
  }
  return problems;
}

/** How many seed statements the catalog manifest declares, every binding together. */
export function seedStatementCount(catalog: Pick<CatalogManifest, "resources">): number {
  return manifestSeeds(catalog.resources ?? {}).reduce(
    (n, [, seed]) => n + seed.statements.length,
    0,
  );
}
