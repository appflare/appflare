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
import {
  DEFAULT_WORKER_NAME,
  workerNameCandidates,
  workersDevSubdomainFromHost,
} from "./worker-name";

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
  /**
   * The id of the Worker version serving this request (the manager's
   * `version_metadata` binding). During setup the token's account must hold
   * a Worker with this version: version ids are unique across Cloudflare, so
   * a hit proves this exact manager runs there, on any hostname and for user
   * tokens that see several accounts. Without it (a manager deployed before
   * the binding existed) the workers.dev subdomain of the host is compared.
   */
  runningVersionId?: string | null;
  fetch?: FetchLike;
  onRequest?: (log: RequestLog) => void;
  baseUrl?: string;
}

export interface VerifyTokenOutcome {
  result: VerifyTokenResult;
  /** The account's scripts from the probe, reused to find the manager's Worker. */
  scripts: WorkerScript[] | null;
  /** The manager's own Worker, when setup found it by its running version. */
  workerName: string | null;
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
  wrongAccount: (account: string, subdomain: string) =>
    `This token belongs to account ${account}, but this manager runs in the account with workers.dev subdomain "${subdomain}". Create the token in that account.`,
  subdomainUnreadable: (account: string) =>
    `Appflare could not read the workers.dev subdomain of account ${account} to confirm it runs there. The token needs the Workers Scripts permission.`,
  noAccountWithSubdomain: (n: number, subdomain: string) =>
    `None of the ${n} accounts this token can access has the workers.dev subdomain "${subdomain}" this manager runs on. Create the token in that account.`,
  notThisAccount: (account: string, subdomain: string | null) =>
    `This token is for account ${account}, but this Appflare does not run in that account${
      subdomain === null
        ? ""
        : ` (it runs in the account with workers.dev subdomain "${subdomain}")`
    }. Create the token in the account Appflare is installed in.`,
  noAccountRunsThis: (n: number) =>
    `None of the ${n} accounts this token can access runs this Appflare. Create the token in the account Appflare is installed in.`,
  workersUnreadable: (account: string) =>
    `Appflare could not list the Workers of account ${account} to confirm it runs there. The token needs the Workers Scripts: Edit permission.`,
  cannotVerifyAccount:
    "This manager cannot verify which Cloudflare account it runs in, so it cannot accept a token here. Update it or reinstall it, or open it at its workers.dev address.",
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
      return { result: { ok: false, error: error.message }, scripts: null, workerName: null };
    }
    if (error instanceof CloudflareApiError) {
      return { result: { ok: false, error: MESSAGES.rejected }, scripts: null, workerName: null };
    }
    // fetch() itself failed (network). Its message never contains request headers.
    return { result: { ok: false, error: MESSAGES.unreachable }, scripts: null, workerName: null };
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
  let workerName: string | null = null;

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
    // Setup. Without the running version's id and off workers.dev there is
    // nothing to confirm the account against: refuse every token, before any
    // call, rather than trust whichever account the token names.
    const versionId = opts.runningVersionId ?? null;
    const hasVersion = versionId !== null && versionId.length > 0;
    if (!hasVersion && workersDevSubdomainFromHost(opts.host) === null) {
      throw new VerifyFailed(MESSAGES.cannotVerifyAccount);
    }
    // User verify first; its failure means an account token or a bad token.
    // `/user/tokens/verify` is not account-scoped, so the client's account id is unused.
    const [asUser, listed] = await Promise.all([
      attempt(() => clientFor("").tokens.verifyUserToken()),
      attempt(() => listAccounts(opts)),
    ]);
    accounts = listed;
    if (accounts === null) {
      throw new VerifyFailed(asUser === null ? MESSAGES.rejectedOrNoAccount : MESSAGES.noAccount);
    }
    let account: AccountSummary;
    if (hasVersion && versionId !== null) {
      const found = await accountRunningVersion(accounts, opts.host, versionId, clientFor);
      account = found.account;
      workerName = found.workerName;
    } else {
      account = await pickAccount(accounts, opts.host, clientFor);
    }
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
    workerName,
  };
}

/**
 * Most Worker version lookups one setup verification makes, across every
 * account, so a user token that sees many accounts or scripts stays well
 * inside a Worker invocation's subrequest limit.
 */
const MAX_VERSION_LOOKUPS = 25;

/**
 * The manager's Worker names worth asking first: the host's workers.dev
 * label candidates and the default name, then the other scripts (a renamed
 * manager on a custom domain).
 */
function managerNameCandidates(host: string, scripts: readonly WorkerScript[]): string[] {
  const names = scripts.map((s) => s.id);
  const present = new Set(names);
  const first = [...workerNameCandidates(host), DEFAULT_WORKER_NAME].filter((n) => present.has(n));
  return [...new Set([...first, ...names])];
}

/**
 * The account holding the Worker version this request runs on, and that
 * Worker's name: for each account the token sees, list its scripts and ask
 * for the version on the likely candidates. A version id is unique across
 * Cloudflare, so a hit is exact. Refuses when no account holds it.
 */
async function accountRunningVersion(
  accounts: AccountSummary[],
  host: string,
  versionId: string,
  clientFor: (accountId: string) => CloudflareClient,
): Promise<{ account: AccountSummary; workerName: string }> {
  const [only] = accounts;
  if (only === undefined) throw new VerifyFailed(MESSAGES.noAccount);
  let lookups = 0;
  let readable = 0;
  for (const account of accounts.slice(0, MAX_ACCOUNTS_PROBED)) {
    const client = clientFor(account.id);
    const scripts = await attempt(() => client.workers.listScripts());
    if (scripts === null) continue;
    readable++;
    for (const name of managerNameCandidates(host, scripts)) {
      if (lookups >= MAX_VERSION_LOOKUPS) break;
      lookups++;
      const version = await attempt(() => client.versions.getVersion(name, versionId));
      if (version !== null) return { account, workerName: name };
    }
  }
  const label = only.name ? `${only.name} (${only.id})` : only.id;
  if (accounts.length > 1) throw new VerifyFailed(MESSAGES.noAccountRunsThis(accounts.length));
  throw new VerifyFailed(
    readable === 0
      ? MESSAGES.workersUnreadable(label)
      : MESSAGES.notThisAccount(label, workersDevSubdomainFromHost(host)),
  );
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
 * The account the manager runs in, for a manager without the running
 * version's id: confirmed, for one account or many, by matching the
 * account's workers.dev subdomain against the `*.workers.dev` host. A token
 * from another account that also has an `appflare` Worker must never be
 * saved onto that Worker. Called only on a workers.dev host; anywhere else
 * setup refuses before this.
 */
async function pickAccount(
  accounts: AccountSummary[],
  host: string,
  clientFor: (accountId: string) => CloudflareClient,
): Promise<AccountSummary> {
  const [only] = accounts;
  if (only === undefined) throw new VerifyFailed(MESSAGES.noAccount);
  const subdomain = workersDevSubdomainFromHost(host);
  if (subdomain === null) throw new VerifyFailed(MESSAGES.cannotVerifyAccount);
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
