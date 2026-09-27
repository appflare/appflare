import { type CatalogSecret, isSeedOnly } from "@appflare/schema";

/**
 * Generated seed-only secrets (a first admin's password) of installs this
 * browser tab just started, held in memory until the install's job page shows
 * them once. Never stored: not in the URL, history state, or browser storage,
 * so a reload or another tab shows nothing, and the page forgets them as soon
 * as it has shown them. Appflare's server never keeps them either.
 */

/** One generated seed-only secret, as the job page shows it. */
export interface SeedCredential {
  name: string;
  label: string;
  value: string;
}

const held = new Map<string, SeedCredential[]>();

/** The seed-only secrets the install form generated, with the values it sent. */
export function generatedSeedCredentials(
  secrets: readonly Pick<CatalogSecret, "name" | "label" | "generate" | "seedOnly">[],
  values: Readonly<Record<string, string | undefined>>,
): SeedCredential[] {
  return secrets.flatMap((s) => {
    const value = values[s.name];
    return isSeedOnly(s) && s.generate !== false && value !== undefined && value.length > 0
      ? [{ name: s.name, label: s.label, value }]
      : [];
  });
}

/** Keeps `credentials` for the job page of `jobId`. */
export function holdSeedCredentials(jobId: string, credentials: readonly SeedCredential[]): void {
  if (credentials.length > 0) held.set(jobId, [...credentials]);
}

/** What is held for `jobId`, without forgetting it. */
export function peekSeedCredentials(jobId: string): SeedCredential[] {
  return held.get(jobId) ?? [];
}

/** Forgets what is held for `jobId`: the page showed it. */
export function forgetSeedCredentials(jobId: string): void {
  held.delete(jobId);
}
