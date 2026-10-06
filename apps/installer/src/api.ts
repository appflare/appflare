import { CloudflareApiError, type CloudflareClient, type FetchLike } from "@appflare/cf-api";
import type { SigningKey } from "@appflare/schema";
import { z } from "zod";
import { Budget, budgetedFetch } from "./budget";
import { activeZones, checkHostname, namesInUse, nameTakenMessage } from "./checks";
import { runCleanup } from "./cleanup";
import { cloudflareFor, cloudflareRequestError, hasCode } from "./cloudflare";
import { ConfigError, type InstallerConfig, readConfig } from "./config";
import { ensureMigrated } from "./db/migrate";
import type { InstallationRow } from "./db/schema";
import { REMOVING, runStep, stepResponse } from "./deploy/run";
import { handoffSecretValue } from "./deploy/upload";
import {
  accountIdSchema,
  bearerToken,
  errorResponse,
  handoffHashSchema,
  InstallerError,
  installationIdSchema,
  json,
  keySchema,
  readBody,
} from "./http";
import { logError } from "./log";
import {
  DEFAULT_WORKER_NAME,
  d1NameFor,
  kvTitleFor,
  MANAGER_WORKFLOW_NAME,
  normalizeHostname,
  workerNameSchema,
  workersDevAddress,
  workflowNameFor,
} from "./names";
import { probeHandoff } from "./proof";
import {
  acquireLease,
  createDb,
  type Database,
  deleteRecord,
  getRecord,
  hashKey,
  insertRecord,
  keyMatches,
  listForAccount,
  newKey,
  recordWithKey,
  releaseLease,
  updateRecord,
} from "./records";
import { ReleaseError, ReleaseFetchError } from "./release/fetch";
import { HANDOFF_SECRET } from "./release/manifest";
import {
  type ChosenRelease,
  chooseRelease,
  ReleaseTooOldError,
  ReleaseUnsupportedError,
} from "./release/source";

/**
 * The hosted installer's API, under `/api/install/`. Every route is a POST
 * with a JSON body; all but `complete` carry the visitor's Cloudflare access
 * token as `Authorization: Bearer`. Each request does one bounded piece of
 * work (at most 40 subrequests) and records progress in D1, so a closed tab
 * simply stops and a later request continues from the record.
 */

export interface AppDeps {
  /** Outgoing fetch: Cloudflare's API, GitHub, and the new manager. */
  fetch: FetchLike;
  /** Trusted release signing keys (the embedded Appflare keys). */
  keys: readonly SigningKey[];
  now?: () => number;
}

interface Ctx {
  request: Request;
  db: Database;
  config: InstallerConfig;
  fetch: FetchLike;
  budget: Budget;
  keys: readonly SigningKey[];
  now: number;
}

const PREFIX = "/api/install/";

export async function handleRequest(request: Request, env: Env, deps: AppDeps): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) {
    return errorResponse(new InstallerError(404, "not_found", "There is nothing here."));
  }
  if (request.method !== "POST") {
    return errorResponse(new InstallerError(405, "method_not_allowed", "Use POST."));
  }
  let config: InstallerConfig;
  try {
    config = readConfig(env);
  } catch (error) {
    // Variable names only; no value is ever logged.
    logError("config", { problems: error instanceof ConfigError ? error.message : "unreadable" });
    return errorResponse(
      new InstallerError(
        503,
        "unavailable",
        "Installing Appflare from the browser is not available right now. Try again later, or install it with create-appflare.",
      ),
    );
  }
  const budget = new Budget();
  const ctx: Ctx = {
    request,
    db: createDb(env.DB),
    config,
    fetch: budgetedFetch(deps.fetch, budget),
    budget,
    keys: deps.keys,
    now: (deps.now ?? Date.now)(),
  };
  try {
    await ensureMigrated(env.DB);
    return await route(url.pathname.slice(PREFIX.length).split("/"), ctx);
  } catch (error) {
    if (error instanceof InstallerError) return errorResponse(error);
    logError("internal", {
      name: error instanceof Error ? error.name : typeof error,
      ...(error instanceof CloudflareApiError ? { status: error.status } : {}),
    });
    return errorResponse(
      new InstallerError(
        500,
        "internal",
        "Something went wrong on our side. Try again in a moment.",
      ),
    );
  }
}

function route(parts: string[], ctx: Ctx): Promise<Response> {
  const [first, second, third, ...rest] = parts;
  if (rest.length === 0 && third === undefined) {
    if (first === "accounts" && second === undefined) return accounts(ctx);
    if (first === "zones" && second === undefined) return zones(ctx);
    if (first === "check" && second === undefined) return check(ctx);
    if (first === "installations" && second === undefined) return create(ctx);
    if (first === "installations" && second === "find") return find(ctx);
  }
  if (first === "installations" && second !== undefined && rest.length === 0) {
    const id = installationIdSchema.safeParse(second);
    if (id.success) {
      if (third === "step") return step(ctx, id.data);
      if (third === "handoff-secret") return handoffSecret(ctx, id.data);
      if (third === "cleanup") return cleanup(ctx, id.data);
      if (third === "complete") return complete(ctx, id.data);
    }
  }
  throw new InstallerError(404, "not_found", "There is nothing here.");
}

/** Accounts beyond this many are listed without their workers.dev subdomain (null). */
const SUBDOMAIN_LOOKUPS = 30;

async function accounts(ctx: Ctx): Promise<Response> {
  const token = bearerToken(ctx.request);
  await readBody(ctx.request, z.object({}));
  let listed: Awaited<ReturnType<CloudflareClient["accounts"]["list"]>>;
  try {
    listed = await cloudflareFor(token, ctx.fetch, "").accounts.list({ maxPages: 2 });
  } catch (error) {
    throw cloudflareRequestError(error, "This sign-in cannot list your Cloudflare accounts.");
  }
  const out: Array<{ id: string; name: string; workersDevSubdomain: string | null }> = [];
  for (const [i, account] of listed.entries()) {
    out.push({
      id: account.id,
      name: account.name,
      workersDevSubdomain:
        i < SUBDOMAIN_LOOKUPS
          ? await workersDevSubdomain(cloudflareFor(token, ctx.fetch, account.id))
          : null,
    });
  }
  return json({ accounts: out });
}

/** The account's workers.dev subdomain, or null when it has none or the token may not read it. */
async function workersDevSubdomain(api: CloudflareClient): Promise<string | null> {
  try {
    const { subdomain } = await api.workers.getAccountSubdomain();
    return subdomain.length > 0 ? subdomain : null;
  } catch (error) {
    const failure = cloudflareRequestError(error, "");
    if (failure.code === "cloudflare_auth" || failure.code === "cloudflare_unavailable")
      throw failure;
    return null;
  }
}

const accountBody = z.object({ accountId: accountIdSchema });

async function zones(ctx: Ctx): Promise<Response> {
  const token = bearerToken(ctx.request);
  const { accountId } = await readBody(ctx.request, accountBody);
  const api = cloudflareFor(token, ctx.fetch, accountId);
  try {
    const list = await activeZones(api);
    return json({ zones: list.map((z) => ({ id: z.id, name: z.name })) });
  } catch (error) {
    throw cloudflareRequestError(error, "This sign-in cannot list the domains of that account.");
  }
}

const hostnameField = z.string().min(1).max(253).nullable();

function hostnameOf(input: string | null): string | null {
  if (input === null) return null;
  const hostname = normalizeHostname(input);
  if (hostname === null) {
    throw new InstallerError(
      400,
      "invalid_hostname",
      "Enter a hostname such as appflare.example.com, without https:// or a path.",
    );
  }
  return hostname;
}

const NOT_IN_ACCOUNT = (hostname: string) =>
  new InstallerError(
    400,
    "hostname_not_in_account",
    `${hostname} is not under an active domain of this Cloudflare account. Choose one of the account's domains.`,
  );

async function check(ctx: Ctx): Promise<Response> {
  const token = bearerToken(ctx.request);
  const body = await readBody(
    ctx.request,
    z.object({ accountId: accountIdSchema, workerName: workerNameSchema, hostname: hostnameField }),
  );
  const hostname = hostnameOf(body.hostname);
  const api = cloudflareFor(token, ctx.fetch, body.accountId);
  try {
    const workflowName = workflowNameFor(
      MANAGER_WORKFLOW_NAME,
      DEFAULT_WORKER_NAME,
      body.workerName,
    );
    const used = await namesInUse(api, body.workerName, workflowName);
    const recorded = (await listForAccount(ctx.db, body.accountId)).some(
      (r) => r.worker_name === body.workerName,
    );
    let hostnameResult: null | "free" | { conflict: string; detail: string } = null;
    if (hostname !== null) {
      const result = await checkHostname(api, hostname, body.workerName);
      if (result.kind === "no-zone") throw NOT_IN_ACCOUNT(hostname);
      hostnameResult =
        result.kind === "free"
          ? "free"
          : result.kind === "conflict"
            ? result.conflict
            : {
                conflict: "worker",
                detail: `${hostname} already serves the Worker "${body.workerName}".`,
              };
    }
    return json({
      workerName: used.length > 0 || recorded ? "taken" : "free",
      hostname: hostnameResult,
    });
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw cloudflareRequestError(error, "This sign-in cannot read what the account already has.");
  }
}

/** Unfinished installations one account may have at once. */
const MAX_UNFINISHED = 10;

async function create(ctx: Ctx): Promise<Response> {
  const token = bearerToken(ctx.request);
  const body = await readBody(
    ctx.request,
    z.object({
      accountId: accountIdSchema,
      workerName: workerNameSchema,
      hostname: hostnameField,
      handoffHash: handoffHashSchema,
    }),
  );
  const hostname = hostnameOf(body.hostname);
  const { workerName, accountId } = body;
  const api = cloudflareFor(token, ctx.fetch, accountId);

  const existing = await listForAccount(ctx.db, accountId);
  if (existing.some((r) => r.worker_name === workerName)) {
    throw new InstallerError(409, "name_taken", nameTakenMessage(workerName, ["installation"]));
  }
  if (existing.length >= MAX_UNFINISHED) {
    throw new InstallerError(
      409,
      "too_many",
      "This account has too many unfinished installations. Continue or remove one of them first.",
    );
  }

  let subdomain: string | null;
  try {
    subdomain = (await api.workers.getAccountSubdomain()).subdomain || null;
  } catch (error) {
    // 10007: the account has not set up its workers.dev subdomain.
    if (!hasCode(error, 10007)) {
      throw cloudflareRequestError(error, "This sign-in cannot create Workers in that account.");
    }
    subdomain = null;
  }
  if (hostname === null && subdomain === null) {
    throw new InstallerError(
      409,
      "no_workers_dev",
      "This Cloudflare account has no workers.dev address yet. Choose one of your domains, or open Workers & Pages in the Cloudflare dashboard once to set up workers.dev.",
    );
  }

  const release = await releaseOrError(ctx);
  const binding = release.manifest.worker.bindings.find((b) => b.type === "workflow");
  const workflowName = workflowNameFor(
    String(binding?.workflow_name ?? MANAGER_WORKFLOW_NAME),
    release.manifest.worker.name,
    workerName,
  );

  let zoneId: string | null = null;
  try {
    const used = await namesInUse(api, workerName, workflowName);
    if (used.length > 0)
      throw new InstallerError(409, "name_taken", nameTakenMessage(workerName, used));
    if (hostname !== null) {
      const result = await checkHostname(api, hostname, workerName);
      if (result.kind === "no-zone") throw NOT_IN_ACCOUNT(hostname);
      if (result.kind !== "free") {
        throw new InstallerError(
          409,
          "hostname_taken",
          result.kind === "conflict"
            ? result.conflict.detail
            : `${hostname} already serves a Worker.`,
        );
      }
      zoneId = result.zone.id;
    }
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw cloudflareRequestError(error, "This sign-in cannot read what the account already has.");
  }

  const id = crypto.randomUUID();
  const key = newKey();
  const address =
    hostname !== null ? `https://${hostname}` : workersDevAddress(workerName, subdomain ?? "");
  await insertRecord(ctx.db, {
    id,
    account_id: accountId,
    worker_name: workerName,
    hostname,
    zone_id: zoneId,
    address,
    workers_dev_subdomain: subdomain,
    release_version: release.version,
    release_digest: release.digest,
    release_manifest: release.text,
    release_zip_url: release.zipUrl,
    release_key_id: release.keyId,
    key_hash: await hashKey(key),
    handoff_hash: body.handoffHash,
    status: "running",
    step: "release",
    message: null,
    d1_name: d1NameFor(workerName),
    kv_title: kvTitleFor(workerName),
    workflow_name: workflowName,
    created_at: ctx.now,
    updated_at: ctx.now,
  });
  return json({ installationId: id, key, release: { version: release.version }, address });
}

async function releaseOrError(ctx: Ctx): Promise<ChosenRelease> {
  try {
    return await chooseRelease(ctx.fetch, ctx.config, ctx.keys);
  } catch (error) {
    if (error instanceof ReleaseTooOldError) {
      throw new InstallerError(
        409,
        "release_too_old",
        `The newest Appflare release (${error.version}) cannot be installed from the browser; that needs Appflare ${error.minimum} or newer. Try again after the next release, or install with create-appflare.`,
      );
    }
    if (error instanceof ReleaseUnsupportedError) {
      logError("release_unsupported", { version: error.version });
      throw new InstallerError(
        409,
        "release_unsupported",
        `The newest Appflare release (${error.version}) needs a newer version of this installer. Try again later, or install with create-appflare.`,
      );
    }
    if (error instanceof ReleaseFetchError) {
      throw new InstallerError(
        502,
        "release_unavailable",
        "GitHub, where Appflare's releases are stored, did not answer. Try again in a moment.",
        error.retryable ? 5_000 : undefined,
      );
    }
    if (error instanceof ReleaseError) {
      logError("release_refused", { kind: error.kind });
      throw releaseRefusal(error);
    }
    throw error;
  }
}

/** What the visitor reads when the newest release cannot be installed, by what is wrong with it. */
function releaseRefusal(error: ReleaseError): InstallerError {
  const later = "Try again later, or install Appflare with create-appflare.";
  switch (error.kind) {
    case "missing":
      return new InstallerError(
        409,
        "no_release",
        `GitHub does not list an Appflare release to install right now. ${later}`,
      );
    case "signature":
      return new InstallerError(
        502,
        "release_invalid",
        `The newest Appflare release does not carry a valid Appflare signature, so it is not installed. ${later}`,
      );
    case "format":
      return new InstallerError(
        409,
        "release_unsupported",
        `The newest Appflare release is packed in a way this installer does not read yet. ${later}`,
      );
    default:
      return new InstallerError(
        502,
        "release_invalid",
        `The newest Appflare release's description of its files could not be read, so it is not installed. ${later}`,
      );
  }
}

/** Proves the token reaches `accountId` (`GET /accounts/{id}`). */
async function requireAccountAccess(api: CloudflareClient): Promise<void> {
  try {
    await api.accounts.get();
  } catch (error) {
    const failure = cloudflareRequestError(
      error,
      "This sign-in cannot reach that Cloudflare account.",
    );
    if (failure.code === "cloudflare_error") {
      // Not found, or any other refusal: the token does not reach the account.
      throw new InstallerError(
        403,
        "cloudflare_forbidden",
        "This sign-in cannot reach that Cloudflare account.",
      );
    }
    throw failure;
  }
}

function summary(record: InstallationRow) {
  const progress = stepResponse(record);
  return {
    id: record.id,
    workerName: record.worker_name,
    hostname: record.hostname,
    address: record.address,
    status: record.status,
    step: progress.step,
    done: progress.done,
    total: progress.total,
    release: { version: record.release_version },
    createdAt: new Date(record.created_at).toISOString(),
    updatedAt: new Date(record.updated_at).toISOString(),
    ...(record.message === null ? {} : { message: record.message }),
  };
}

async function find(ctx: Ctx): Promise<Response> {
  const token = bearerToken(ctx.request);
  const { accountId } = await readBody(ctx.request, accountBody);
  await requireAccountAccess(cloudflareFor(token, ctx.fetch, accountId));
  const rows = await listForAccount(ctx.db, accountId);
  return json({ installations: rows.map(summary) });
}

const keyBody = z.object({ key: keySchema });

/** Runs `work` holding the record's lease, or answers that another request holds it. */
async function withLease<T>(
  ctx: Ctx,
  id: string,
  busy: () => T,
  work: () => Promise<T>,
): Promise<T> {
  const owner = crypto.randomUUID();
  if (!(await acquireLease(ctx.db, id, owner, ctx.now))) return busy();
  try {
    return await work();
  } finally {
    await releaseLease(ctx.db, id, owner);
  }
}

async function step(ctx: Ctx, id: string): Promise<Response> {
  const token = bearerToken(ctx.request);
  const { key } = await readBody(ctx.request, keyBody);
  const record = await recordWithKey(ctx.db, id, key);
  if (record.status === "removing") {
    throw REMOVING;
  }
  if (record.status === "deployed") return json(stepResponse(record));
  const api = cloudflareFor(token, ctx.fetch, record.account_id);
  const result = await withLease(
    ctx,
    id,
    () =>
      stepResponse(record, {
        status: "waiting",
        retryAfterMs: 2_000,
        message: "Another window is working on this installation.",
      }),
    async () =>
      runStep(await getRecord(ctx.db, id), {
        db: ctx.db,
        api,
        fetch: ctx.fetch,
        budget: ctx.budget,
        config: ctx.config,
        now: ctx.now,
      }),
  );
  return json(result);
}

async function handoffSecret(ctx: Ctx, id: string): Promise<Response> {
  const token = bearerToken(ctx.request);
  const body = await readBody(
    ctx.request,
    z.object({ key: keySchema, handoffHash: handoffHashSchema }),
  );
  const record = await recordWithKey(ctx.db, id, body.key);
  if (record.status === "removing") {
    throw REMOVING;
  }
  const busy = () => {
    throw new InstallerError(
      409,
      "busy",
      "Another window is working on this installation. Try again in a moment.",
      2_000,
    );
  };
  await withLease(ctx, id, busy, async () => {
    const current = await getRecord(ctx.db, id);
    if (current.status === "removing") throw REMOVING;
    const uploaded = current.worker_created || current.worker_attempt_at !== null;
    if (uploaded) {
      // Replaced only while the manager is still waiting for its connection:
      // asked at the chosen address, or at workers.dev while the domain is not live.
      const addresses = [current.address];
      if (current.hostname !== null && current.workers_dev_subdomain !== null) {
        addresses.push(workersDevAddress(current.worker_name, current.workers_dev_subdomain));
      }
      let state: string | null = null;
      for (const address of addresses) {
        const probe = await probeHandoff(ctx.fetch, address, current.handoff_hash);
        if (probe.kind === "verified") {
          state = probe.state;
          break;
        }
      }
      if (state === null) {
        throw new InstallerError(
          409,
          "not_reachable",
          "Appflare does not answer at its address yet, so its setup key cannot be replaced safely. Try again in a minute.",
          30_000,
        );
      }
      if (state !== "waiting") {
        throw new InstallerError(
          409,
          "handoff_received",
          `This Appflare has already received its Cloudflare connection. Open ${current.address} to continue.`,
        );
      }
      try {
        await cloudflareFor(token, ctx.fetch, current.account_id).workers.putSecret(
          current.worker_name,
          {
            name: HANDOFF_SECRET,
            text: handoffSecretValue(body.handoffHash),
          },
        );
      } catch (error) {
        throw cloudflareRequestError(error, "This sign-in cannot change the Appflare Worker.");
      }
    }
    await updateRecord(ctx.db, id, { handoff_hash: body.handoffHash, proof_attempts: 0 }, ctx.now);
  });
  return json({ ok: true });
}

async function cleanup(ctx: Ctx, id: string): Promise<Response> {
  const token = bearerToken(ctx.request);
  const body = await readBody(ctx.request, z.object({ key: keySchema.optional() }));
  const record = await getRecord(ctx.db, id);
  const api = cloudflareFor(token, ctx.fetch, record.account_id);
  if (body.key !== undefined) {
    if (!(await keyMatches(record, body.key))) {
      throw new InstallerError(
        403,
        "wrong_key",
        "This browser's key for the installation does not match.",
      );
    }
  } else {
    // Without the key, the token proves the right to remove it: it reaches the account.
    await requireAccountAccess(api);
  }
  const busy = () => {
    throw new InstallerError(
      409,
      "busy",
      "Another window is working on this installation. Try again in a moment.",
      2_000,
    );
  };
  const owner = crypto.randomUUID();
  if (!(await acquireLease(ctx.db, id, owner, ctx.now))) busy();
  try {
    const result = await runCleanup(await getRecord(ctx.db, id), {
      db: ctx.db,
      api,
      fetch: ctx.fetch,
      budget: ctx.budget,
      now: ctx.now,
    });
    return json(result);
  } finally {
    // The record may be gone; then there is nothing to release.
    await releaseLease(ctx.db, id, owner);
  }
}

async function complete(ctx: Ctx, id: string): Promise<Response> {
  const { key } = await readBody(ctx.request, keyBody);
  const record = await getRecord(ctx.db, id);
  if (!(await keyMatches(record, key))) {
    throw new InstallerError(403, "wrong_key", "The key does not match this installation.");
  }
  await deleteRecord(ctx.db, id);
  return json({ ok: true });
}
