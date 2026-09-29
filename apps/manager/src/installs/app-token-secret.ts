import {
  appTokenPermissions,
  type CatalogPipelines,
  type CatalogSecret,
  cloudflareTokenSecret,
  enteredSecrets,
  isSeedOnly,
  type TokenPermission,
} from "@appflare/schema";

/**
 * Which secret of an app takes the Cloudflare API token the admin creates
 * for it (the catalog manifest's `tokenPermissions`), so the forms can show
 * how to create the token right next to that secret's field: the secret the
 * entry declares with `cloudflareToken: true`, else the one a Pipelines sink
 * names (`sink.tokenSecret`), whose token permissions Appflare adds. Null
 * when the app needs no token of its own, or no secret takes it (the app's
 * own setup steps then say where the token goes).
 */
export function appTokenSecret(catalog: {
  secrets: readonly CatalogSecret[];
  tokenPermissions: readonly TokenPermission[];
  resources?: { pipelines?: CatalogPipelines | undefined } | undefined;
}): string | null {
  if (appTokenPermissions(catalog).length === 0) return null;
  const candidates = enteredSecrets(catalog.secrets).filter((s) => !isSeedOnly(s));
  const declared = cloudflareTokenSecret(candidates);
  if (declared !== null) return declared.name;
  const names = new Set(candidates.map((s) => s.name));
  for (const pipeline of Object.values(catalog.resources?.pipelines ?? {})) {
    if (names.has(pipeline.sink.tokenSecret)) return pipeline.sink.tokenSecret;
  }
  return null;
}
