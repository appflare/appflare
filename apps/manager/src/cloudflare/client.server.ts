import {
  type CloudflareClient,
  createClient,
  type FetchLike,
  type RequestLog,
} from "@appflare/cf-api";
import { createDb } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import { apiBaseOption } from "./api-base";
import { type ConnectionEnv, cloudflareConnection, connectionProblem } from "./connection.server";
import { type GrantRow, readGrant } from "./grant-store.server";

/**
 * The manager's Cloudflare API client, built from its Cloudflare connection
 * (connection.server.ts: the `CF_API_TOKEN` binding, or a stored OAuth
 * grant whose access token is renewed as it runs out) and the account id
 * the setup wizard cached in `settings`.
 */

/** Thrown when the setup wizard's connect step has not completed (or not redeployed yet). */
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

export interface CfClientEnv extends ConnectionEnv {
  DB: D1Database;
  /** Optional API base override (tests, local dev against a fake API). */
  CF_API_BASE_URL?: string;
}

export async function getCfClient(
  env: CfClientEnv,
  opts: {
    fetch?: FetchLike;
    /** Also sees every request (`METHOD path -> status`), e.g. to put it in a job log. */
    onRequest?: (entry: RequestLog) => void;
    /** The account id from `settings`, when the caller read it already. */
    accountId?: string;
    /** The stored grant (`readGrant`), when the caller read it already: saves a round trip. */
    grant?: GrantRow | null;
  } = {},
): Promise<CloudflareClient> {
  // Both reads at once; the credential provider then starts from the grant
  // read here, so building a client adds no read of its own.
  const [grant, recorded] = await Promise.all([
    opts.grant === undefined ? readGrant(env.DB) : Promise.resolve(opts.grant),
    opts.accountId === undefined
      ? readSettings(createDb(env.DB), [SETTING.accountId]).then((s) => s.account_id)
      : Promise.resolve(opts.accountId),
  ]);
  if (grant === null && (env.CF_API_TOKEN === undefined || env.CF_API_TOKEN.length === 0)) {
    // Never set up, or set up and the version with the token still rolling out.
    const problem = await connectionProblem(env);
    if (problem === null || problem.problem === "not_configured") {
      throw new CfTokenNotConfiguredError("token");
    }
    throw problem;
  }
  const accountId = recorded;
  if (accountId === undefined || accountId.length === 0) {
    throw new CfTokenNotConfiguredError("account");
  }
  const base: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  // The refresh, when one is due, goes through the same fetch as the calls.
  const connection = cloudflareConnection(env, { fetch: base }, { grant });
  return createClient({
    accountId,
    token: connection.token,
    fetch: connection.retrying(base),
    onRequest: (entry) => {
      logCfRequest(entry);
      opts.onRequest?.(entry);
    },
    ...apiBaseOption(env),
  });
}
