import { getAuthenticatorName } from "@better-auth/passkey";
import type { Auth } from "./server";

/**
 * The signed-in user's own passkeys, for Settings. Both calls go through Better
 * Auth's passkey endpoints with the caller's request headers, so the plugin's
 * session check and ownership check apply: a user only ever sees and removes
 * their own passkeys, whatever their role.
 */

export interface PasskeyRow {
  id: string;
  /** The name the user gave it when adding it; older or unnamed ones have none. */
  name: string | null;
  /** Best-effort provider label from the authenticator model, e.g. "1Password". */
  provider: string | null;
  /** True when the passkey syncs across devices (a password manager or platform account). */
  synced: boolean;
  /** ISO 8601, or null if the row predates the timestamp. */
  createdAt: string | null;
  /**
   * The hostname the passkey was added at, when that is not the address the
   * list was read at: the browser offers a passkey only at its own hostname,
   * so this one works only there. Unset when it works here.
   */
  worksAt?: string | null;
}

/**
 * `rows` with `worksAt` set from `hosts` (passkey id to the hostname it was
 * added at, for passkeys added at an address Appflare has since left) where
 * that hostname is not `currentHostname`.
 */
export function withPasskeyHosts(
  rows: readonly PasskeyRow[],
  hosts: ReadonlyMap<string, string>,
  currentHostname: string,
): PasskeyRow[] {
  const here = currentHostname.toLowerCase();
  return rows.map((row) => {
    const host = hosts.get(row.id)?.toLowerCase();
    return { ...row, worksAt: host === undefined || host === here ? null : host };
  });
}

interface StoredPasskey {
  id: string;
  name?: string | null | undefined;
  aaguid?: string | null | undefined;
  backedUp: boolean;
  createdAt?: Date | string | null | undefined;
}

export function toPasskeyRow(p: StoredPasskey): PasskeyRow {
  return {
    id: p.id,
    name: p.name?.trim() ? p.name.trim() : null,
    provider: getAuthenticatorName(p.aaguid) ?? null,
    synced: p.backedUp,
    createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
  };
}

/** Oldest first, so a newly added passkey appears at the bottom of the list. */
export async function listOwnPasskeys(auth: Auth, headers: Headers): Promise<PasskeyRow[]> {
  const passkeys = await auth.api.listPasskeys({ headers });
  return passkeys
    .map(toPasskeyRow)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

export async function removeOwnPasskey(auth: Auth, headers: Headers, id: string): Promise<void> {
  await auth.api.deletePasskey({ body: { id }, headers });
}
