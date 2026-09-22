import {
  CLOUDFLARE_API_BASE,
  CloudflareApiError,
  type CloudflareClient,
  type CloudflareEnvelope,
  createClient,
  type FetchLike,
  type RequestLog,
  type TokenVerifyResult,
  type WorkerScript,
} from "@appflare/cf-api";
import { workersDevSubdomainFromHost } from "./worker-name";

/**
 * Verifies a pasted Cloudflare API token and discovers the account it belongs to.
 * Pure over an injectable `fetch`, so
 * it is tested without the real API.
 *
 * Token type detection follows wrangler (`packages/wrangler/src/user/whoami.ts`,
 * `getTokenType`): `GET /user/tokens/verify` succeeds for user tokens and fails
 * (code 1000) for account tokens, which verify at
 * `GET /accounts/{id}/tokens/verify` and need the account id first. The account id
 * comes from `GET /accounts`, which account tokens may call too (wrangler's
 * `fetchAllAccounts` falls back to it for them, `packages/workers-auth`).
 *
 * The token never appears in a return value, an error message, or a log line:
 * `CloudflareApiError` messages carry only method, path, status, and Cloudflare's
 * error text, and the messages below are fixed strings.
 */

export type TokenType = "account" | "user";

export interface TokenVerification {
  ok: true;
  tokenType: TokenType;
  accountId: string;
  accountName?: string;
  /** ISO 8601; absent when the token never expires. */
  expiresOn?: string;
  /** The required capability probe (listing Workers scripts) succeeded. */
  permissionsOk: boolean;
  /** Permission groups a probe could not confirm, by dashboard name. */
  missing: string[];
}

export interface TokenVerificationFailure {
  ok: false;
  error: string;
}

export type VerifyTokenResult = TokenVerification | TokenVerificationFailure;

export interface VerifyTokenOptions {
  token: string;
  /** `settings.account_id` once known (token rotation); null during setup. */
  knownAccountId: string | null;
  /** The request host, used to pick the account when a user token sees several. */
  host: string;
  fetch?: FetchLike;
  onRequest?: (log: RequestLog) => void;
  baseUrl?: string;
}

export interface VerifyTokenOutcome {
  result: VerifyTokenResult;
  /** The account's scripts from the probe, reused to find the manager's Worker. */
  scripts: WorkerScript[] | null;
}

export const MESSAGES = {
  rejected:
    "Cloudflare rejected this token. Check that you copied the whole value and that the token is active.",
  rejectedOrNoAccount:
    "Cloudflare rejected this token, or it lacks the Account Settings: Read permission Appflare needs to find its account.",
  noAccount:
    "This token cannot see any Cloudflare account. Add the Account Settings: Read permission.",
  otherAccount:
    "This token is not valid for the Cloudflare account Appflare runs in. Create it in that account.",
  ambiguous: (n: number) =>
    `This token can access ${n} accounts and Appflare could not tell which one it runs in. Create an account API token in that account instead.`,
  wrongAccount: (account: string, subdomain: string) =>
    `This token belongs to account ${account}, but this manager runs in the account with workers.dev subdomain "${subdomain}". Create the token in that account.`,
  subdomainUnreadable: (account: string) =>
    `Appflare could not read the workers.dev subdomain of account ${account} to confirm it runs there. The token needs the Workers Scripts permission.`,
  noAccountWithSubdomain: (n: number, subdomain: string) =>
    `None of the ${n} accounts this token can access has the workers.dev subdomain "${subdomain}" this manager runs on. Create the token in that account.`,
  customDomainNeedsAccountToken:
    "This manager is not on a workers.dev address, so Appflare cannot confirm which account a user token is for. Create an account API token in the account Appflare runs in.",
  inactive: (status: string) => `This token is ${status}. Use an active token.`,
  unreachable: "Could not reach the Cloudflare API. Try again.",
} as const;

/**
 * Capability probes: one cheap list call per permission
 * group. Listing Workers scripts is required (the manager cannot store the token
 * on itself without it); the others only add warnings. A list call proves read
 * access; the groups are named as the template requests them.
 */
const SCRIPTS_PERMISSION = "Workers Scripts: Edit";

interface Probe {
  /** Dashboard permission group name, shown when the probe fails. */
  missing: string;
  run(client: CloudflareClient): Promise<unknown>;
}

const OPTIONAL_PROBES: readonly Probe[] = [
  { missing: "Workers KV Storage: Edit", run: (c) => c.kv.listNamespaces() },
  { missing: "D1: Edit", run: (c) => c.d1.listDatabases() },
];

/** Most accounts a user token may see before Appflare stops probing subdomains. */
const MAX_ACCOUNTS_PROBED = 20;

interface AccountSummary {
  id: string;
  name?: string;
}

class VerifyFailed extends Error {}

export async function verifyCloudflareToken(opts: VerifyTokenOptions): Promise<VerifyTokenOutcome> {
  try {
    return await verify(opts);
  } catch (error) {
    if (error instanceof VerifyFailed) {
      return { result: { ok: false, error: error.message }, scripts: null };
    }
    if (error instanceof CloudflareApiError) {
      return { result: { ok: false, error: MESSAGES.rejected }, scripts: null };
    }
    // fetch() itself failed (network). Its message never contains request headers.
    return { result: { ok: false, error: MESSAGES.unreachable }, scripts: null };
  }
}

async function verify(opts: VerifyTokenOptions): Promise<VerifyTokenOutcome> {
  const clientFor = (accountId: string) =>
    createClient({
      accountId,
      token: opts.token,
      fetch: opts.fetch,
      onRequest: opts.onRequest,
      baseUrl: opts.baseUrl,
    });
  const missing: string[] = [];

  let tokenType: TokenType;
  let info: TokenVerifyResult;
  let accountId: string;
  let accounts: AccountSummary[] | null;

  if (opts.knownAccountId !== null) {
    // Rotation: the account is fixed; an account token for it verifies there.
    accountId = opts.knownAccountId;
    const asAccount = await attempt(() => clientFor(accountId).tokens.verify());
    if (asAccount !== null) {
      tokenType = "account";
      info = asAccount;
    } else {
      const asUser = await attempt(() => clientFor(accountId).tokens.verifyUserToken());
      if (asUser === null) throw new VerifyFailed(MESSAGES.otherAccount);
      tokenType = "user";
      info = asUser;
    }
    accounts = await attempt(() => listAccounts(opts));
    if (accounts === null) {
      missing.push("Account Settings: Read");
    } else if (tokenType === "user" && !accounts.some((a) => a.id === accountId)) {
      throw new VerifyFailed(MESSAGES.otherAccount);
    }
  } else {
    // Setup: user verify first; its failure means an account token or a bad token.
    // `/user/tokens/verify` is not account-scoped, so the client's account id is unused.
    const [asUser, listed] = await Promise.all([
      attempt(() => clientFor("").tokens.verifyUserToken()),
      attempt(() => listAccounts(opts)),
    ]);
    accounts = listed;
    if (accounts === null) {
      throw new VerifyFailed(asUser === null ? MESSAGES.rejectedOrNoAccount : MESSAGES.noAccount);
    }
    const account = await pickAccount(accounts, opts.host, clientFor);
    accountId = account.id;
    if (asUser !== null) {
      tokenType = "user";
      info = asUser;
    } else {
      const asAccount = await attempt(() => clientFor(accountId).tokens.verify());
      if (asAccount === null) throw new VerifyFailed(MESSAGES.rejected);
      tokenType = "account";
      info = asAccount;
    }
    // On a custom domain the account cannot be matched to the host (pickAccount),
    // so only an account token, which is bound to exactly one account, is accepted.
    // TODO: also compare the running version (a `version_metadata` binding,
    // CF_VERSION_METADATA) against the chosen account's `appflare` versions, so an
    // account token from the wrong account is caught on custom domains too.
    if (workersDevSubdomainFromHost(opts.host) === null && tokenType === "user") {
      throw new VerifyFailed(MESSAGES.customDomainNeedsAccountToken);
    }
  }

  if (info.status !== "active") throw new VerifyFailed(MESSAGES.inactive(info.status));

  const client = clientFor(accountId);
  const [scripts, ...optional] = await Promise.all([
    attempt(() => client.workers.listScripts()),
    ...OPTIONAL_PROBES.map((p) => attempt(() => p.run(client))),
  ]);
  const permissionsOk = scripts !== null;
  if (!permissionsOk) missing.push(SCRIPTS_PERMISSION);
  OPTIONAL_PROBES.forEach((probe, i) => {
    if (optional[i] === null) missing.push(probe.missing);
  });

  const accountName = accounts?.find((a) => a.id === accountId)?.name;
  return {
    result: {
      ok: true,
      tokenType,
      accountId,
      ...(accountName ? { accountName } : {}),
      ...(info.expires_on ? { expiresOn: info.expires_on } : {}),
      permissionsOk,
      missing,
    },
    scripts,
  };
}

/** Runs a Cloudflare call; an API error (not a network error) becomes null. */
async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CloudflareApiError) return null;
    throw error;
  }
}

/**
 * The account the manager runs in. On a `*.workers.dev` host that is always
 * confirmed, for one account or many, by matching the account's workers.dev
 * subdomain against the host: a token from another account that also has an
 * `appflare` Worker must never be saved onto that Worker. On a custom domain
 * only a single account is accepted (and `verify` then requires an account token).
 */
async function pickAccount(
  accounts: AccountSummary[],
  host: string,
  clientFor: (accountId: string) => CloudflareClient,
): Promise<AccountSummary> {
  const [only] = accounts;
  if (only === undefined) throw new VerifyFailed(MESSAGES.noAccount);
  const subdomain = workersDevSubdomainFromHost(host);
  if (subdomain === null) {
    if (accounts.length === 1) return only;
    throw new VerifyFailed(MESSAGES.ambiguous(accounts.length));
  }
  const readable: AccountSummary[] = [];
  for (const account of accounts.slice(0, MAX_ACCOUNTS_PROBED)) {
    const found = await attempt(() => clientFor(account.id).workers.getAccountSubdomain());
    if (found === null) continue;
    readable.push(account);
    if (found.subdomain.toLowerCase() === subdomain) return account;
  }
  if (accounts.length > 1) {
    throw new VerifyFailed(MESSAGES.noAccountWithSubdomain(accounts.length, subdomain));
  }
  const label = only.name ? `${only.name} (${only.id})` : only.id;
  throw new VerifyFailed(
    readable.length === 0
      ? MESSAGES.subdomainUnreadable(label)
      : MESSAGES.wrongAccount(label, subdomain),
  );
}

/** `GET /accounts` page size, and the most pages followed. */
const ACCOUNTS_PER_PAGE = 50;
const MAX_ACCOUNT_PAGES = 20;

/**
 * `GET /accounts`, following `result_info` pagination (at most 20 pages of 50).
 * `@appflare/cf-api` has no accounts namespace (the manager needs only
 * this endpoint), so this is the one direct call; it reports through the same
 * `onRequest` hook and throws `CloudflareApiError`.
 */
async function listAccounts(opts: VerifyTokenOptions): Promise<AccountSummary[]> {
  const path = "/accounts";
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const accounts: AccountSummary[] = [];
  for (let page = 1; page <= MAX_ACCOUNT_PAGES; page++) {
    const url = `${opts.baseUrl ?? CLOUDFLARE_API_BASE}${path}?page=${page}&per_page=${ACCOUNTS_PER_PAGE}`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
    });
    opts.onRequest?.({ method: "GET", path, status: res.status });
    let envelope: Partial<CloudflareEnvelope<unknown>> = {};
    try {
      envelope = (await res.json()) as Partial<CloudflareEnvelope<unknown>>;
    } catch {
      // Non-JSON (gateway page): treated as a failure below without surfacing the body.
    }
    if (!res.ok || envelope.success !== true || !Array.isArray(envelope.result)) {
      throw new CloudflareApiError({
        status: res.status,
        method: "GET",
        path,
        errors: envelope.errors ?? [],
      });
    }
    for (const row of envelope.result) {
      if (typeof row !== "object" || row === null) continue;
      const { id, name } = row as { id?: unknown; name?: unknown };
      if (typeof id !== "string") continue;
      accounts.push(typeof name === "string" ? { id, name } : { id });
    }
    const totalPages = envelope.result_info?.total_pages;
    if (totalPages === undefined || page >= totalPages || envelope.result.length === 0) break;
  }
  return accounts;
}
