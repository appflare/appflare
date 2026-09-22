import {
  type CloudflareClient,
  createClient,
  type FetchLike,
  type RequestLog,
} from "@appflare/cf-api";
import { createDb } from "../db/client";
import { readSettings, SETTING } from "../db/settings";

/**
 * The manager's Cloudflare API client, built from its own `CF_API_TOKEN` binding
 * and the account id the setup wizard cached in `settings`.
 */

/** Thrown when the setup wizard's token step has not completed (or not redeployed yet). */
export class CfTokenNotConfiguredError extends Error {
  override name = "CfTokenNotConfiguredError";
  constructor(readonly missing: "token" | "account") {
    super(
      missing === "token"
        ? "The Cloudflare API token is not configured. Finish setup at /setup."
        : "The Cloudflare account is not known yet. Finish setup at /setup.",
    );
  }
}

/**
 * Every cf-api call is logged as `METHOD path -> status` only:
 * paths carry no query string and never a secret.
 */
export function logCfRequest({ method, path, status }: RequestLog): void {
  console.log(`${method} ${path} -> ${status}`);
}

export interface CfClientEnv {
  DB: D1Database;
  CF_API_TOKEN?: string;
}

export async function getCfClient(
  env: CfClientEnv,
  opts: { fetch?: FetchLike } = {},
): Promise<CloudflareClient> {
  const token = env.CF_API_TOKEN;
  if (token === undefined || token.length === 0) throw new CfTokenNotConfiguredError("token");
  const { account_id: accountId } = await readSettings(createDb(env.DB), [SETTING.accountId]);
  if (accountId === undefined || accountId.length === 0) {
    throw new CfTokenNotConfiguredError("account");
  }
  return createClient({ accountId, token, fetch: opts.fetch, onRequest: logCfRequest });
}
