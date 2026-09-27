import {
  appTokenPermissions,
  type CatalogPipelines,
  type CatalogSecret,
  enteredSecrets,
  isSeedOnly,
  type TokenPermission,
} from "@appflare/schema";

/**
 * Which secret of an app takes the Cloudflare API token the admin creates
 * for it (the catalog manifest's `tokenPermissions`), so the forms can show
 * how to create the token right next to that secret's field.
 *
 * A Pipelines sink names its token secret (`sink.tokenSecret`). Otherwise
 * the catalog has no field for it, so the secret is recognised by the names
 * apps give such tokens: `CF_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CF_TOKEN`,
 * `CF_BEARER_TOKEN`, and the same with a prefix (`NUXT_CF_API_TOKEN`).
 * Null when the app needs no token of its own, or none of its secrets takes
 * it (the app's own setup steps then say where the token goes).
 */
const TOKEN_SECRET_NAME = /(?:^|_)(?:CF|CLOUDFLARE)_(?:[A-Z0-9]+_)?TOKEN$/;

export function appTokenSecret(catalog: {
  secrets: readonly CatalogSecret[];
  tokenPermissions: readonly TokenPermission[];
  resources?: { pipelines?: CatalogPipelines | undefined } | undefined;
}): string | null {
  if (appTokenPermissions(catalog).length === 0) return null;
  const candidates = enteredSecrets(catalog.secrets).filter((s) => !isSeedOnly(s));
  const names = new Set(candidates.map((s) => s.name));
  for (const pipeline of Object.values(catalog.resources?.pipelines ?? {})) {
    if (names.has(pipeline.sink.tokenSecret)) return pipeline.sink.tokenSecret;
  }
  return candidates.find((s) => TOKEN_SECRET_NAME.test(s.name))?.name ?? null;
}
