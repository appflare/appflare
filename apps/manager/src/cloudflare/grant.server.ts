import {
  CloudflareOAuthError,
  createClient,
  type FetchLike,
  missingManagerScopes,
  type RefreshedTokens,
  type RequestLog,
} from "@appflare/cf-api";
import { createDb } from "../db/client";
import { readSettings, SETTING, type SettingKey } from "../db/settings";
import {
  type ConnectionMemo,
  holdKey,
  isolateConnectionMemo,
  openStoredGrant,
  parseKeyInfo,
  refreshWithRetries,
  revokeGrant,
} from "./connection.server";
import { withConnectionLock } from "./connection-lock.server";
import type { ConnectionKind } from "./connection-view";
import {
  GRANT_KEY_SECRET,
  type GrantKey,
  generateGrantKey,
  importGrantKey,
  sealContext,
  sealValue,
} from "./grant-seal";
import {
  deleteGrantStatement,
  type GrantRow,
  readGrant,
  replaceGrantStatements,
} from "./grant-store.server";
import { GRANT_MESSAGES, verifyGrantAccount } from "./verify-token";

/**
 * Storing an OAuth grant as the manager's Cloudflare connection, and
 * throwing it away when an API token replaces it. Framework-free: the
 * handoff from the browser that installed the manager and the OAuth
 * reconnect in Settings call {@link storeGrant}; the API token save and
 * rotation (server/token.server.ts) call {@link clearGrantForApiToken}.
 * The connection never changes kind on its own, only through these.
 */

export interface GrantInput {
  refreshToken: string;
  /** The OAuth client the grant was issued to. */
  clientId: string;
  /** The scopes the authorization reported, used when the refresh does not report them. */
  scopes: readonly string[];
}

export interface StoreGrantDeps {
  db: D1Database;
  /** The running Worker's `CF_GRANT_KEY`, when it has one. */
  grantKey?: string;
  grant: GrantInput;
  /** The account the grant must manage (the one the user chose, or the one already recorded). */
  accountId: string;
  /** The request host, for a manager without the running version's id. */
  host: string;
  /** The Worker version serving this request (`CF_VERSION_METADATA.id`), when bound. */
  runningVersionId: string | null;
  fetch?: FetchLike;
  onRequest?: (log: RequestLog) => void;
  baseUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * What refreshing `grant` already returned, when the caller refreshed it
   * and kept the rotated refresh token itself (the handoff): no refresh is
   * made here.
   */
  refreshed?: RefreshedTokens;
  /**
   * Revoke the refreshed grant when it is refused or cannot be stored
   * (default). False when the caller keeps it and decides.
   */
  revokeOnFailure?: boolean;
  /** Test seams. */
  memo?: ConnectionMemo;
  generateKey?: () => string;
}

export interface StoredGrant {
  accountId: string;
  accountName: string | null;
  workerName: string;
  /** The scopes Cloudflare granted. */
  scopes: string[];
  /**
   * A new `CF_GRANT_KEY` was written to the Worker, which deploys a new
   * version of it. Until that version serves everywhere, other isolates
   * answer with "still redeploying" (this one already holds the key).
   */
  keyWritten: boolean;
  /** What the connection was before: an API token, another grant, or nothing. */
  previous: ConnectionKind | null;
}

/**
 * Why a grant was refused, for a caller that answers each case differently
 * (the OAuth reconnect's outcome on Settings): `other_account`, the grant is
 * for another account than the one recorded or does not run this manager
 * there; `missing_scopes`; `refused` and `rejected`, Cloudflare would not
 * renew it; `unreachable`; `busy`, another connection change holds the lock;
 * `unverifiable`, this manager cannot tell which account it runs in.
 */
export type GrantStoreReason =
  | "busy"
  | "refused"
  | "unreachable"
  | "rejected"
  | "missing_scopes"
  | "other_account"
  | "unverifiable";

/** A refused grant; the message is shown as is and never carries a token. */
export class GrantStoreError extends Error {
  override name = "GrantStoreError";
  constructor(
    message: string,
    readonly reason: GrantStoreReason = "rejected",
  ) {
    super(message);
  }
}

/** The reason for a failed `verifyGrantAccount`, from its fixed messages. */
function verifyReason(message: string): GrantStoreReason {
  if (message === GRANT_MESSAGES.unreachable) return "unreachable";
  if (message === GRANT_MESSAGES.cannotVerifyAccount) return "unverifiable";
  // It cannot list the account's Workers (every scope was granted, so it is
  // not this account), or the account does not run this manager.
  return "other_account";
}

export const GRANT_STORE_MESSAGES = {
  busy: "Another change to the Cloudflare connection is in progress. Try again in a minute.",
  refused:
    "Cloudflare did not accept this authorization: it was already used, withdrawn, or has expired. Connect Cloudflare again.",
  unreachable: "Appflare could not reach Cloudflare to take over this authorization. Try again.",
  rejected: (code: string) =>
    `Cloudflare refused this authorization (${code}). Connect Cloudflare again.`,
  missingScopes:
    "Cloudflare granted Appflare fewer permissions than it needs. Connect again and allow every permission Appflare asks for.",
  otherAccount:
    "Appflare manages another Cloudflare account. Connect the account Appflare runs in.",
} as const;

/** A failed refresh of a grant handed over, as the refusal to show; other errors as they are. */
export function grantRefreshError(error: unknown): unknown {
  if (!(error instanceof CloudflareOAuthError)) return error;
  if (error.reconnectNeeded) return new GrantStoreError(GRANT_STORE_MESSAGES.refused, "refused");
  if (error.retryable) {
    return new GrantStoreError(GRANT_STORE_MESSAGES.unreachable, "unreachable");
  }
  return new GrantStoreError(GRANT_STORE_MESSAGES.rejected(error.code), "rejected");
}

/** An upsert of one `settings` row, for a batch. */
function settingStatement(
  db: D1Database,
  key: SettingKey,
  value: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, at);
}

/**
 * The key to seal the grant with: the running Worker's own when it is the
 * one last written, else one this isolate wrote itself and still holds, else
 * a new one, which has to be written to the Worker (`write`).
 */
async function chooseKey(
  deps: StoreGrantDeps,
  memo: ConnectionMemo,
  stored: string | undefined,
): Promise<{ key: GrantKey; write: string | null }> {
  const last = parseKeyInfo(stored);
  const own = deps.grantKey ? await importGrantKey(deps.grantKey) : null;
  if (own !== null && (last === null || last.id === own.id)) return { key: own, write: null };
  const held = last === null ? undefined : memo.keys.get(last.id);
  if (last !== null && held !== undefined) return { key: { id: last.id, key: held }, write: null };
  const secret = (deps.generateKey ?? generateGrantKey)();
  const key = await importGrantKey(secret);
  if (key === null) throw new Error("a generated Cloudflare connection key could not be imported");
  return { key, write: secret };
}

/**
 * Stores a grant as the manager's Cloudflare connection:
 *
 * 1. Refreshes it at once, unless the caller did (`refreshed`). The manager
 *    takes over rotation, so the copy whoever handed it over still holds
 *    stops mattering.
 * 2. Checks that it carries every scope the manager asks for, and that it
 *    can manage this manager in `accountId`: this Worker's running version
 *    must be in that account (`verifyGrantAccount`), as the token step
 *    checks a pasted token.
 * 3. Writes the key on the Worker as `CF_GRANT_KEY` when it has none yet
 *    (the first grant), which deploys a new version; this isolate keeps the
 *    key in hand, so the rest of this request and the next ones it serves
 *    work before that version does.
 * 4. Stores the grant sealed, replacing any other, and records the account,
 *    the Worker and the time. The connection's kind is now OAuth.
 * 5. Revokes the grant it replaced, if any, best effort.
 *
 * When a check fails after the refresh, the new grant is revoked, since
 * nobody else holds it any more (unless `revokeOnFailure` is false: the
 * caller kept it). Serialized with token saves.
 */
export async function storeGrant(deps: StoreGrantDeps): Promise<StoredGrant> {
  const memo = deps.memo ?? isolateConnectionMemo();
  const now = deps.now ?? Date.now;
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return withConnectionLock(
    deps.db,
    () => new GrantStoreError(GRANT_STORE_MESSAGES.busy, "busy"),
    async () => {
      const stored = await readSettings(createDb(deps.db), [
        SETTING.accountId,
        SETTING.cfGrantKey,
        SETTING.cfTokenConfigured,
      ]);
      if (stored.account_id && stored.account_id !== deps.accountId) {
        throw new GrantStoreError(GRANT_STORE_MESSAGES.otherAccount, "other_account");
      }

      let tokens: RefreshedTokens;
      if (deps.refreshed !== undefined) {
        tokens = deps.refreshed;
      } else {
        try {
          tokens = await refreshWithRetries(
            { clientId: deps.grant.clientId, refreshToken: deps.grant.refreshToken },
            { fetch: fetchImpl, now, sleep },
          );
        } catch (error) {
          throw grantRefreshError(error);
        }
      }
      // Only this call holds the rotated refresh token now (unless the caller
      // keeps it): a refusal below revokes it.
      const abandon = async (error: unknown): Promise<never> => {
        if (deps.revokeOnFailure !== false) {
          await revokeGrant(
            { clientId: deps.grant.clientId, refreshToken: tokens.refreshToken },
            { fetch: fetchImpl },
          );
        }
        throw error;
      };

      const scopes = tokens.scopes ?? [...deps.grant.scopes];
      if (missingManagerScopes(scopes).length > 0) {
        return abandon(new GrantStoreError(GRANT_STORE_MESSAGES.missingScopes, "missing_scopes"));
      }
      const verified = await verifyGrantAccount({
        token: tokens.accessToken,
        accountId: deps.accountId,
        host: deps.host,
        runningVersionId: deps.runningVersionId,
        fetch: fetchImpl,
        onRequest: deps.onRequest,
        baseUrl: deps.baseUrl,
      }).catch(abandon);
      if (!verified.ok) {
        return abandon(new GrantStoreError(verified.error, verifyReason(verified.error)));
      }

      const previousRow = await readGrant(deps.db);
      const previous = await openStoredGrant(
        { DB: deps.db, CF_GRANT_KEY: deps.grantKey },
        { memo },
        previousRow,
      );
      const { key, write } = await chooseKey(deps, memo, stored.cf_grant_key);
      if (write !== null) {
        const api = createClient({
          accountId: deps.accountId,
          token: tokens.accessToken,
          fetch: fetchImpl,
          onRequest: deps.onRequest,
          baseUrl: deps.baseUrl,
        });
        // Only this one call sees the key: never logged, stored or returned.
        await api.workers
          .putSecret(verified.workerName, {
            name: GRANT_KEY_SECRET,
            type: "secret_text",
            text: write,
          })
          .catch(abandon);
      }
      holdKey(memo, key);

      const id = crypto.randomUUID();
      const at = now();
      const row: GrantRow = {
        id,
        clientId: deps.grant.clientId,
        scopes,
        refreshToken: await sealValue(key.key, tokens.refreshToken, sealContext(id, "refresh")),
        accessToken: await sealValue(key.key, tokens.accessToken, sealContext(id, "access")),
        accessExpiresAt: tokens.expiresAt,
        keyId: key.id,
        status: "connected",
        problem: null,
        problemAt: null,
        connectedAt: at,
        refreshedAt: at,
      };
      const settings: D1PreparedStatement[] = [
        settingStatement(deps.db, SETTING.accountId, deps.accountId, at),
        settingStatement(deps.db, SETTING.workerName, verified.workerName, at),
        settingStatement(deps.db, SETTING.cfTokenConfigured, "1", at),
        settingStatement(deps.db, SETTING.cfTokenVerifiedAt, new Date(at).toISOString(), at),
      ];
      if (verified.accountName !== null) {
        settings.push(settingStatement(deps.db, SETTING.accountName, verified.accountName, at));
      }
      if (write !== null) {
        settings.push(
          settingStatement(
            deps.db,
            SETTING.cfGrantKey,
            JSON.stringify({ id: key.id, writtenAt: at }),
            at,
          ),
        );
      }
      await deps.db.batch([...replaceGrantStatements(deps.db, row), ...settings]).catch(abandon);
      memo.access = { grantId: id, token: tokens.accessToken, expiresAt: tokens.expiresAt };

      if (previous !== null && previous.refreshToken !== tokens.refreshToken) {
        await revokeGrant(previous, { fetch: fetchImpl });
      }
      return {
        accountId: deps.accountId,
        accountName: verified.accountName,
        workerName: verified.workerName,
        scopes,
        keyWritten: write !== null,
        previous:
          previousRow !== null ? "oauth" : stored.cf_token_configured === "1" ? "api_token" : null,
      };
    },
  );
}

/**
 * An API token was just stored as `CF_API_TOKEN` in place of a grant: the
 * grant is deleted, which makes the connection an API token again, and then
 * revoked at Cloudflare, best effort. Call it holding the connection lock,
 * after the token is stored. Nothing happens when no grant is stored.
 */
export async function clearGrantForApiToken(deps: {
  db: D1Database;
  /** The running Worker's `CF_GRANT_KEY`, to open the grant for revoking. */
  grantKey?: string;
  fetch?: FetchLike;
  memo?: ConnectionMemo;
}): Promise<{ hadGrant: boolean; revoked: boolean }> {
  const memo = deps.memo ?? isolateConnectionMemo();
  const row = await readGrant(deps.db);
  if (row === null) return { hadGrant: false, revoked: false };
  const held = await openStoredGrant({ DB: deps.db, CF_GRANT_KEY: deps.grantKey }, { memo }, row);
  await deleteGrantStatement(deps.db).run();
  if (memo.access?.grantId === row.id) memo.access = null;
  const revoked = held === null ? false : await revokeGrant(held, { fetch: deps.fetch });
  return { hadGrant: true, revoked };
}
