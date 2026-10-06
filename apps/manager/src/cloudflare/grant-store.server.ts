import type { CloudflareGrantStatus } from "../db/schema";

/**
 * The `cloudflare_grant` row as the connection reads and writes it. Raw D1
 * statements, so a refresh can update exactly the grant it renewed (a grant
 * replaced in the meantime is left alone). The values in `refreshToken` and
 * `accessToken` are sealed (grant-seal.ts); nothing here opens them.
 */

export interface GrantRow {
  id: string;
  clientId: string;
  scopes: string[];
  /** Sealed. */
  refreshToken: string;
  /** Sealed; null once the grant needs reconnecting. */
  accessToken: string | null;
  /** Epoch ms. */
  accessExpiresAt: number | null;
  keyId: string;
  status: CloudflareGrantStatus;
  problem: string | null;
  problemAt: number | null;
  connectedAt: number;
  refreshedAt: number;
}

interface RawGrant {
  id: string;
  client_id: string;
  scopes_json: string;
  refresh_token: string;
  access_token: string | null;
  access_expires_at: number | null;
  key_id: string;
  status: string;
  problem: string | null;
  problem_at: number | null;
  connected_at: number;
  refreshed_at: number;
}

function scopesOf(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function rowOf(raw: RawGrant): GrantRow {
  return {
    id: raw.id,
    clientId: raw.client_id,
    scopes: scopesOf(raw.scopes_json),
    refreshToken: raw.refresh_token,
    accessToken: raw.access_token,
    accessExpiresAt: raw.access_expires_at,
    keyId: raw.key_id,
    status: raw.status === "needs_reconnect" ? "needs_reconnect" : "connected",
    problem: raw.problem,
    problemAt: raw.problem_at,
    connectedAt: raw.connected_at,
    refreshedAt: raw.refreshed_at,
  };
}

/**
 * The stored grant, or null when the manager connects with an API token.
 * A database the running version has not migrated yet has no grant table,
 * and so no grant.
 */
export async function readGrant(db: D1Database): Promise<GrantRow | null> {
  try {
    const raw = await db
      .prepare("SELECT * FROM cloudflare_grant ORDER BY connected_at DESC LIMIT 1")
      .first<RawGrant>();
    return raw === null ? null : rowOf(raw);
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) return null;
    throw error;
  }
}

/** Replaces any stored grant with `row`, as one statement in a batch. */
export function replaceGrantStatements(db: D1Database, row: GrantRow): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM cloudflare_grant"),
    db
      .prepare(
        `INSERT INTO cloudflare_grant (id, client_id, scopes_json, refresh_token, access_token,
           access_expires_at, key_id, status, problem, problem_at, connected_at, refreshed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        row.id,
        row.clientId,
        JSON.stringify(row.scopes),
        row.refreshToken,
        row.accessToken,
        row.accessExpiresAt,
        row.keyId,
        row.status,
        row.problem,
        row.problemAt,
        row.connectedAt,
        row.refreshedAt,
      ),
  ];
}

/** Deletes every stored grant. */
export function deleteGrantStatement(db: D1Database): D1PreparedStatement {
  return db.prepare("DELETE FROM cloudflare_grant");
}

/** Renewed tokens, sealed, as {@link saveRenewal} stores them. */
export interface GrantRenewal {
  refreshToken: string;
  accessToken: string;
  accessExpiresAt: number;
  scopes: string[] | null;
  at: number;
}

/**
 * Stores the renewed tokens of grant `id`, only while it still holds
 * `sentRefreshToken` (sealed, as read before the refresh): a request whose
 * refresh outlived its lease must not overwrite a newer rotation. A grant
 * another request marked as needing reconnecting while this refresh was out
 * (its own refresh, with the token this one had already rotated, was
 * refused) is connected again: these tokens work. False when the grant
 * changed or is gone.
 */
export async function saveRenewal(
  db: D1Database,
  id: string,
  sentRefreshToken: string,
  renewal: GrantRenewal,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE cloudflare_grant SET refresh_token = ?3, access_token = ?4, access_expires_at = ?5,
         scopes_json = COALESCE(?6, scopes_json), refreshed_at = ?7, status = 'connected',
         problem = NULL, problem_at = NULL
       WHERE id = ?1 AND refresh_token = ?2`,
    )
    .bind(
      id,
      sentRefreshToken,
      renewal.refreshToken,
      renewal.accessToken,
      renewal.accessExpiresAt,
      renewal.scopes === null ? null : JSON.stringify(renewal.scopes),
      renewal.at,
    )
    .run();
  return result.meta.changes === 1;
}

/**
 * Grant `id` needs reconnecting: no more refreshes until another credential
 * is stored. Only while it still holds `sentRefreshToken` (sealed): when
 * another request stored a rotation meanwhile, the refusal was about a token
 * that had already been replaced, and the grant is fine. False then.
 */
export async function markNeedsReconnect(
  db: D1Database,
  id: string,
  sentRefreshToken: string,
  problem: string,
  at: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE cloudflare_grant SET status = 'needs_reconnect', access_token = NULL,
         access_expires_at = NULL, problem = ?3, problem_at = ?4
       WHERE id = ?1 AND refresh_token = ?2`,
    )
    .bind(id, sentRefreshToken, problem, at)
    .run();
  return result.meta.changes === 1;
}

/** Records a renewal problem without changing the grant's state. */
export async function recordProblem(
  db: D1Database,
  id: string,
  problem: string,
  at: number,
): Promise<void> {
  await db
    .prepare("UPDATE cloudflare_grant SET problem = ?2, problem_at = ?3 WHERE id = ?1")
    .bind(id, problem, at)
    .run();
}
