import { MANAGER_OAUTH_API_SCOPES } from "@appflare/cf-api";
import { isolateConnectionMemo } from "../cloudflare/connection.server";
import { generateGrantKey, importGrantKey, sealContext, sealValue } from "../cloudflare/grant-seal";
import { type GrantRow, replaceGrantStatements } from "../cloudflare/grant-store.server";

/**
 * Connects a test's manager with Cloudflare sign-in: stores a grant whose
 * access token is `accessToken`, good for an hour from `now`, and clears
 * this isolate's memo of earlier tests' grants. Returns the key the grant is
 * sealed with, for the environment's `CF_GRANT_KEY`.
 */
export async function seedSignIn(
  db: D1Database,
  opts: { accessToken: string; scopes?: readonly string[]; now?: number },
): Promise<string> {
  const secret = generateGrantKey();
  const key = await importGrantKey(secret);
  if (key === null) throw new Error("no grant key");
  const memo = isolateConnectionMemo();
  memo.access = null;
  memo.keys.clear();
  memo.envKey = null;
  const now = opts.now ?? Date.now();
  const id = "grant-test";
  const row: GrantRow = {
    id,
    clientId: "client-test",
    scopes: [...(opts.scopes ?? MANAGER_OAUTH_API_SCOPES)],
    refreshToken: await sealValue(key.key, "cf-refresh-DO-NOT-LEAK", sealContext(id, "refresh")),
    accessToken: await sealValue(key.key, opts.accessToken, sealContext(id, "access")),
    accessExpiresAt: now + 60 * 60_000,
    keyId: key.id,
    status: "connected",
    problem: null,
    problemAt: null,
    connectedAt: now - 60_000,
    refreshedAt: now - 60_000,
  };
  await db.batch(replaceGrantStatements(db, row));
  return secret;
}
