import { CloudflareOAuthError, type RefreshedTokens } from "@appflare/cf-api";
import { refreshWithRetries, revokeGrant } from "../cloudflare/connection.server";
import {
  type GrantInput,
  GrantStoreError,
  grantRefreshError,
  type StoredGrant,
  type StoreGrantDeps,
  storeGrant,
} from "../cloudflare/grant.server";
import { openValue, sealValue } from "../cloudflare/grant-seal";
import { handedGrantKey } from "./handoff-proof";

/**
 * The grant the browser handed over, between its first refresh and the
 * moment it is stored as the connection. Refreshing uses up the refresh
 * token the browser holds, so the rotated one is kept at once, sealed with
 * a key derived from the raw handoff secret the browser sends with every
 * try (never from `APPFLARE_HANDOFF`, whose hash the hosted installer
 * wrote and knows), before anything else can fail: the checks of
 * the account, writing `CF_GRANT_KEY`, storing. A try that fails on the way
 * leaves it here, and the next try starts from it instead of the browser's
 * spent copy. A refusal that cannot change (another account, missing
 * permissions) revokes it and forgets it; once stored as the connection it
 * is forgotten.
 */

/** `settings` row: JSON `{ clientId, scopes, salt, refreshToken }`, `refreshToken` sealed. */
const HANDED_GRANT_KEY = "handoff_grant";
const SEAL_CONTEXT = "appflare-handoff-grant";

/** No usable grant: the browser's was spent and none is kept. It must sign in to Cloudflare again. */
export class AuthorizeAgain extends Error {
  override name = "AuthorizeAgain";
  constructor() {
    super("Cloudflare must be connected again from the page that installed Appflare.");
  }
}

/** A failure the next try may get past: kept grants stay kept. */
export function isTemporaryGrantFailure(error: unknown): boolean {
  if (!(error instanceof GrantStoreError)) return true;
  return error.reason === "busy" || error.reason === "unreachable";
}

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded + "==".slice(0, (4 - (padded.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}

async function keep(d1: D1Database, secret: string, grant: GrantInput, now: Date): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const value = JSON.stringify({
    clientId: grant.clientId,
    scopes: grant.scopes,
    salt: toBase64url(salt),
    refreshToken: await sealValue(
      await handedGrantKey(secret, salt),
      grant.refreshToken,
      SEAL_CONTEXT,
    ),
  });
  await d1
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(HANDED_GRANT_KEY, value, now.getTime())
    .run();
}

async function forget(d1: D1Database): Promise<void> {
  await d1.prepare("DELETE FROM settings WHERE key = ?1").bind(HANDED_GRANT_KEY).run();
}

/**
 * The kept grant, or null: none, or one this secret cannot open (the
 * browser started over with a new handoff secret, so nobody can open it
 * any more, nor revoke it), which is then forgotten.
 */
async function readKept(d1: D1Database, secret: string): Promise<GrantInput | null> {
  const row = await d1
    .prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(HANDED_GRANT_KEY)
    .first<{ value: string }>();
  if (row === null) return null;
  try {
    const parsed = JSON.parse(row.value) as {
      clientId?: unknown;
      scopes?: unknown;
      salt?: unknown;
      refreshToken?: unknown;
    };
    if (
      typeof parsed.clientId !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.salt !== "string" ||
      !Array.isArray(parsed.scopes)
    ) {
      throw new Error("malformed");
    }
    return {
      clientId: parsed.clientId,
      scopes: parsed.scopes.filter((s): s is string => typeof s === "string"),
      refreshToken: await openValue(
        await handedGrantKey(secret, fromBase64url(parsed.salt)),
        parsed.refreshToken,
        SEAL_CONTEXT,
      ),
    };
  } catch {
    await forget(d1);
    return null;
  }
}

/**
 * Stores the grant the browser handed over as the connection, starting
 * from the one an earlier try kept, if any. Throws {@link AuthorizeAgain}
 * when neither can be refreshed any more.
 */
export async function storeHandedGrant(
  deps: StoreGrantDeps & {
    /** The raw handoff secret from this request: the only key to what is kept. */
    secret: string;
    at: Date;
  },
): Promise<StoredGrant> {
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const kept = await readKept(deps.db, deps.secret);
  let source: GrantInput | null = null;
  let tokens: RefreshedTokens | null = null;
  for (const candidate of kept === null ? [deps.grant] : [kept, deps.grant]) {
    try {
      tokens = await refreshWithRetries(
        { clientId: candidate.clientId, refreshToken: candidate.refreshToken },
        {
          fetch: fetchImpl,
          now: deps.now ?? Date.now,
          sleep: deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
        },
      );
      source = candidate;
      break;
    } catch (error) {
      if (!(error instanceof CloudflareOAuthError && error.reconnectNeeded)) {
        throw grantRefreshError(error);
      }
      // Spent or withdrawn: the next candidate, if any.
      if (candidate === kept) await forget(deps.db);
    }
  }
  if (source === null || tokens === null) throw new AuthorizeAgain();

  const rotated: GrantInput = {
    clientId: source.clientId,
    scopes: tokens.scopes ?? [...source.scopes],
    refreshToken: tokens.refreshToken,
  };
  let held = true;
  try {
    await keep(deps.db, deps.secret, rotated, deps.at);
  } catch (error) {
    // Not kept: a failure below revokes it rather than lose it unrevoked.
    held = false;
    console.error("handoff: could not keep the renewed authorization", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const stored = await storeGrant({
      ...deps,
      grant: rotated,
      refreshed: tokens,
      revokeOnFailure: !held,
    });
    // Stored as the connection, with this same refresh token: no revoke.
    await forget(deps.db).catch(() => undefined);
    return stored;
  } catch (error) {
    if (held && !isTemporaryGrantFailure(error)) {
      await revokeGrant(
        { clientId: rotated.clientId, refreshToken: rotated.refreshToken },
        { fetch: fetchImpl },
      );
      await forget(deps.db).catch(() => undefined);
    }
    throw error;
  }
}
