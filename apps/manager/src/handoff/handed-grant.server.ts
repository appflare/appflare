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
import { forgetHandedGrant, HANDED_GRANT_KEY } from "./handoff-state.server";

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
 * is forgotten. Creating the owner, or connecting with a pasted API token
 * instead, forgets it too (handoff-state.server.ts).
 *
 * No authorization is left behind at Cloudflare: a fresh one the browser
 * sent while a kept one is used is revoked, and so is a renewed one that
 * could not be kept when storing it then fails.
 */

/**
 * `settings` row: JSON `{ clientId, scopes, salt, sealed }`. `sealed` holds,
 * sealed, `{ refreshToken, handed }`: the kept refresh token, and the
 * fingerprint of the browser's refresh token its chain of renewals started
 * from (that one is spent; a different one the browser sends is a new
 * authorization).
 */
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

interface KeptGrant extends GrantInput {
  /** Fingerprint of the browser's refresh token this grant was renewed from. */
  handed: string;
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

async function fingerprint(refreshToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(refreshToken));
  return toBase64url(new Uint8Array(digest));
}

async function keep(d1: D1Database, secret: string, grant: KeptGrant, now: Date): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const value = JSON.stringify({
    clientId: grant.clientId,
    scopes: grant.scopes,
    salt: toBase64url(salt),
    sealed: await sealValue(
      await handedGrantKey(secret, salt),
      JSON.stringify({ refreshToken: grant.refreshToken, handed: grant.handed }),
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

/**
 * The kept grant, or null: none, or one this secret cannot open (the
 * browser started over with a new handoff secret, so nobody can open it
 * any more, nor revoke it), which is then forgotten.
 */
async function readKept(d1: D1Database, secret: string): Promise<KeptGrant | null> {
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
      sealed?: unknown;
    };
    if (
      typeof parsed.clientId !== "string" ||
      typeof parsed.sealed !== "string" ||
      typeof parsed.salt !== "string" ||
      !Array.isArray(parsed.scopes)
    ) {
      throw new Error("malformed");
    }
    const opened = JSON.parse(
      await openValue(
        await handedGrantKey(secret, fromBase64url(parsed.salt)),
        parsed.sealed,
        SEAL_CONTEXT,
      ),
    ) as { refreshToken?: unknown; handed?: unknown };
    if (typeof opened.refreshToken !== "string" || typeof opened.handed !== "string") {
      throw new Error("malformed");
    }
    return {
      clientId: parsed.clientId,
      scopes: parsed.scopes.filter((s): s is string => typeof s === "string"),
      refreshToken: opened.refreshToken,
      handed: opened.handed,
    };
  } catch {
    await forgetHandedGrant(d1);
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
  const revoke = (grant: GrantInput) =>
    revokeGrant(
      { clientId: grant.clientId, refreshToken: grant.refreshToken },
      { fetch: fetchImpl },
    );
  const handed = await fingerprint(deps.grant.refreshToken);
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
      if (candidate === kept) await forgetHandedGrant(deps.db);
    }
  }
  if (source === null || tokens === null) throw new AuthorizeAgain();
  if (kept !== null && source === kept && kept.handed !== handed) {
    // The kept grant carries on; the browser also sent a new authorization
    // (it signed in again), which nobody will use: withdrawn, best effort.
    // Not the browser's spent copy of the kept one: revoking that could end
    // the kept one with it.
    await revoke(deps.grant);
  }

  const rotated: KeptGrant = {
    clientId: source.clientId,
    scopes: tokens.scopes ?? [...source.scopes],
    refreshToken: tokens.refreshToken,
    handed: source === kept && kept !== null ? kept.handed : handed,
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
    // Revoking on failure is decided here, for every failure, including the
    // ones `storeGrant` refuses before it uses the tokens (busy, another account).
    const stored = await storeGrant({
      ...deps,
      grant: rotated,
      refreshed: tokens,
      revokeOnFailure: false,
    });
    // Stored as the connection, with this same refresh token: no revoke.
    await forgetHandedGrant(deps.db).catch(() => undefined);
    return stored;
  } catch (error) {
    if (!held) {
      // Nobody holds it but this request: withdrawn, best effort.
      await revoke(rotated);
    } else if (!isTemporaryGrantFailure(error)) {
      await revoke(rotated);
      await forgetHandedGrant(deps.db).catch(() => undefined);
    }
    throw error;
  }
}
