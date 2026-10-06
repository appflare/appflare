import {
  CloudflareApiError,
  type CloudflareClient,
  type FetchLike,
  type RequestLog,
} from "@appflare/cf-api";
import { z } from "zod";
import { refreshCapabilities } from "../capabilities/capabilities.server";
import { apiBaseOption } from "../cloudflare/api-base";
import type { ConnectionMemo } from "../cloudflare/connection.server";
import { CloudflareConnectionError } from "../cloudflare/connection-errors";
import { GrantStoreError } from "../cloudflare/grant.server";
import { readGrant } from "../cloudflare/grant-store.server";
import { createDb } from "../db/client";
import { completeAddressMove } from "../domains/manager-address.server";
import { recordPendingAddress } from "../domains/pending-address.server";
import { selfUnits } from "../jobs/units/client";
import {
  type AttemptLimit,
  DEFAULT_ATTEMPT_LIMIT,
  takeAttempt,
} from "../server/attempt-limit.server";
import { runningVersion } from "../server/build-version";
import {
  connectGrantStep,
  ownerClaimStatement,
  SETUP_MESSAGES,
  SetupError,
} from "../server/setup.server";
import { AuthorizeAgain, isTemporaryGrantFailure, storeHandedGrant } from "./handed-grant.server";
import { handoffHashOf, handoffProof, handoffSecretMatches, isChallenge } from "./handoff-proof";
import { HANDOFF_RECEIVED_KEY, readHandoffState } from "./handoff-state.server";
import {
  acceptedInstaller,
  installerDetailsStatement,
  installerOriginOf,
} from "./installer-completion.server";

/**
 * `/api/handoff`: how a manager installed from the browser receives its
 * Cloudflare connection. The hosted installer deploys it with the secret
 * `APPFLARE_HANDOFF = v1.<sha256 of the handoff secret>` and the var
 * `APPFLARE_INSTALLER_ORIGIN`; the installing browser alone knows the
 * handoff secret. Without `APPFLARE_HANDOFF` every request is a 404.
 *
 * - `GET ?challenge=<16-64 base64url>`: `{ app, version, state, proof }`,
 *   where `state` is `waiting`, `received` (the connection arrived) or
 *   `done` (an owner exists) and `proof` shows this manager holds the hash
 *   (handoff-proof.ts). Unauthenticated and cheap: one read, one HMAC.
 * - `POST { secret, grant, accountId, installer?, intendedAddress? }`: with the right secret,
 *   the first call is setup's "Connect Cloudflare" step with the grant
 *   (server/setup.server.ts `connectGrantStep`): the grant is refreshed at
 *   once, checked against the account and the running version, and stored;
 *   a missing auth secret and `SELF` are written; a custom domain of this
 *   Worker the request arrived on becomes Appflare's address (arriving at
 *   workers.dev, the chosen domain, `intendedAddress` or the Worker's only
 *   one, becomes its pending address); the
 *   installer's details are kept for reporting the end of setup. The answer
 *   is the owner setup URL, `https://<host>/setup#claim=<code>`, whose
 *   one-time code `/setup` exchanges for the setup claim. A later call
 *   (the browser lost the answer) leaves the grant alone and issues a fresh
 *   code. Once an owner exists every POST is refused (409).
 *
 * Browsers may call it from `APPFLARE_INSTALLER_ORIGIN` only (CORS, exact
 * match, no credentials). POSTs are rate limited per client address like
 * setup's token step, the secret is compared in constant time, and every
 * refusal has a fixed message. Neither the secret, the grant, the code nor
 * the installer's key is logged or kept in plain text.
 *
 * It answers before Cloudflare Access and the workers.dev redirect, like
 * `/api/health`: the installer and the browser must reach it at the address
 * they chose (access/gate.ts, domains/address-redirect.ts).
 */

/** The largest POST body read: the handoff is a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024;
const PREFLIGHT_MAX_AGE_S = 600;
/** POSTs per client address, like setup's token step: each is one try of a secret. */
export const HANDOFF_ATTEMPT_LIMIT: AttemptLimit = DEFAULT_ATTEMPT_LIMIT;

export const HANDOFF_MESSAGES = {
  forbidden: "This request did not come from the page that installed this Appflare.",
  otherOrigin: "Requests from this page are not accepted.",
  done: "Setup is already complete. Sign in instead.",
  invalid: "This is not a valid handoff request.",
  tooLarge: "This handoff request is too large.",
  needsGrant: "The first handoff must carry the Cloudflare authorization and the account.",
  failed: "Appflare could not finish connecting to Cloudflare. Try again.",
} as const;

export interface HandoffEnv {
  DB: D1Database;
  APPFLARE_VERSION: string;
  APPFLARE_HANDOFF?: string;
  APPFLARE_INSTALLER_ORIGIN?: string;
  BETTER_AUTH_SECRET?: string;
  CF_GRANT_KEY?: string;
  CF_VERSION_METADATA?: { id: string };
  SELF?: unknown;
  CF_API_BASE_URL?: string;
}

export interface HandoffDeps {
  now?: () => Date;
  /** For Cloudflare's API and its OAuth endpoints. */
  fetch?: FetchLike;
  onRequest?: (log: RequestLog) => void;
  /** Work that may finish after the answer (the account capability check). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Test seams. */
  memo?: ConnectionMemo;
  sleep?: (ms: number) => Promise<void>;
  generateAuthSecret?: () => string;
  generateKey?: () => string;
}

const handoffBody = z.object({
  secret: z.string(),
  grant: z
    .object({
      refreshToken: z.string().min(1).max(4096),
      clientId: z.string().min(1).max(256),
      scopes: z.array(z.string().min(1).max(256)).max(200),
    })
    .optional(),
  accountId: z
    .string()
    .regex(/^[A-Za-z0-9]{1,64}$/)
    .optional(),
  installer: z
    .object({
      url: z.string().min(1).max(2048),
      installationId: z.string().min(1).max(128),
      key: z.string().min(1).max(1024),
    })
    .optional(),
  /**
   * The custom domain the installing page reviewed, when it hands over at
   * the workers.dev address because that domain does not serve yet.
   * Optional: without it, the Worker's only custom domain is taken.
   */
  intendedAddress: z
    .string()
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/)
    .optional(),
});

type HandoffBody = z.infer<typeof handoffBody>;

/** Thrown inside the lock when another call stored the connection first. */
class AlreadyReceived extends Error {}

function json(body: unknown, status: number, headers: Headers): Response {
  const out = new Headers(headers);
  out.set("content-type", "application/json");
  out.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: out });
}

function refusal(error: string, message: string, status: number, headers: Headers): Response {
  return json({ error, message }, status, headers);
}

/**
 * The CORS headers for this request: the installer's origin when the
 * request comes from it (exact match), else none.
 */
function corsHeaders(request: Request, installerOrigin: string | null): Headers {
  const headers = new Headers({ vary: "Origin" });
  const origin = request.headers.get("origin");
  if (installerOrigin !== null && origin === installerOrigin) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

export async function handoffResponse(
  request: Request,
  env: HandoffEnv,
  deps: HandoffDeps = {},
): Promise<Response> {
  const hash = handoffHashOf(env.APPFLARE_HANDOFF);
  if (hash === null) {
    return json({ error: "not_found" }, 404, new Headers());
  }
  const installerOrigin = installerOriginOf(env.APPFLARE_INSTALLER_ORIGIN);
  const cors = corsHeaders(request, installerOrigin);
  switch (request.method) {
    case "OPTIONS":
      return preflight(request, installerOrigin);
    case "GET":
    case "HEAD":
      return proofAnswer(request, env, hash, cors);
    case "POST":
      return handOff(request, env, deps, { hash, installerOrigin, cors });
    default: {
      const headers = new Headers(cors);
      headers.set("allow", "GET, HEAD, POST, OPTIONS");
      return refusal("method", HANDOFF_MESSAGES.invalid, 405, headers);
    }
  }
}

/** The CORS preflight: allowed only for the installer's origin, for GET and POST with JSON. */
function preflight(request: Request, installerOrigin: string | null): Response {
  const origin = request.headers.get("origin");
  const method = request.headers.get("access-control-request-method");
  if (installerOrigin === null || origin !== installerOrigin) {
    return new Response(null, { status: 403, headers: { vary: "Origin" } });
  }
  if (method !== "GET" && method !== "POST") {
    return new Response(null, { status: 403, headers: { vary: "Origin" } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": String(PREFLIGHT_MAX_AGE_S),
      vary: "Origin",
    },
  });
}

async function proofAnswer(
  request: Request,
  env: HandoffEnv,
  hash: string,
  cors: Headers,
): Promise<Response> {
  const challenge = new URL(request.url).searchParams.get("challenge");
  if (!isChallenge(challenge)) return refusal("challenge", HANDOFF_MESSAGES.invalid, 400, cors);
  const [state, proof] = await Promise.all([
    readHandoffState(env.DB),
    handoffProof(hash, challenge),
  ]);
  return json({ app: "appflare", version: runningVersion(env), state, proof }, 200, cors);
}

interface PostContext {
  hash: string;
  installerOrigin: string | null;
  cors: Headers;
}

async function hasOwner(d1: D1Database): Promise<boolean> {
  return (await readHandoffState(d1)) === "done";
}

/**
 * The body as text, or null when it is longer than {@link MAX_BODY_BYTES}.
 * Reads at most that much (plus the chunk that passes it), whatever
 * `Content-Length` says or when there is none, and cancels the rest.
 */
async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    await request.body?.cancel();
    return null;
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function handOff(
  request: Request,
  env: HandoffEnv,
  deps: HandoffDeps,
  ctx: PostContext,
): Promise<Response> {
  const { cors } = ctx;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== ctx.installerOrigin) {
    return refusal("forbidden", HANDOFF_MESSAGES.otherOrigin, 403, cors);
  }
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return refusal("invalid", HANDOFF_MESSAGES.invalid, 415, cors);
  }
  // Once an owner exists, nothing is accepted any more, with or without the secret.
  if (await hasOwner(env.DB)) {
    return json({ error: "done", message: HANDOFF_MESSAGES.done }, 409, cors);
  }
  const now = (deps.now ?? (() => new Date()))();
  const client = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(await takeAttempt(env.DB, "handoff", client, now, HANDOFF_ATTEMPT_LIMIT))) {
    return refusal("rate_limited", SETUP_MESSAGES.rateLimited, 429, cors);
  }
  const text = await readBody(request);
  if (text === null) return refusal("invalid", HANDOFF_MESSAGES.tooLarge, 413, cors);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refusal("invalid", HANDOFF_MESSAGES.invalid, 400, cors);
  }
  const secret =
    typeof raw === "object" && raw !== null ? (raw as { secret?: unknown }).secret : undefined;
  if (!(await handoffSecretMatches(secret, ctx.hash))) {
    console.warn("handoff: refused a request without the right secret");
    return refusal("forbidden", HANDOFF_MESSAGES.forbidden, 403, cors);
  }
  const parsed = handoffBody.safeParse(raw);
  if (!parsed.success) return refusal("invalid", HANDOFF_MESSAGES.invalid, 400, cors);
  const body = parsed.data;
  const url = new URL(request.url);

  try {
    if ((await readHandoffState(env.DB)) === "received") {
      return await freshClaim(env, url, now, cors);
    }
    return await firstHandoff(request, env, deps, ctx, body, now);
  } catch (error) {
    if (error instanceof AlreadyReceived) return freshClaim(env, url, now, cors);
    return failure(error, cors);
  }
}

/**
 * A call after the connection arrived: only a new owner claim. Deliberately
 * not refused while another browser holds the setup claim (someone who
 * pasted a token): the code it gives replaces that claim when it is
 * exchanged. Both hold credentials that control the account (the handoff
 * secret came with the Cloudflare authorization), so neither is protected
 * from the other, and the page that installed Appflare must not be locked
 * out of its own setup.
 */
async function freshClaim(env: HandoffEnv, url: URL, now: Date, cors: Headers): Promise<Response> {
  const claim = await ownerClaimStatement(env.DB, now);
  await claim.statement.run();
  return json({ ok: true, ownerSetupUrl: ownerSetupUrl(url, claim.code) }, 200, cors);
}

function ownerSetupUrl(url: URL, code: string): string {
  return `${url.protocol}//${url.host}/setup#claim=${code}`;
}

async function firstHandoff(
  request: Request,
  env: HandoffEnv,
  deps: HandoffDeps,
  ctx: PostContext,
  body: HandoffBody,
  now: Date,
): Promise<Response> {
  const { cors } = ctx;
  if (body.grant === undefined || body.accountId === undefined) {
    return refusal("invalid", HANDOFF_MESSAGES.needsGrant, 400, cors);
  }
  const url = new URL(request.url);
  const installer =
    body.installer === undefined ? null : acceptedInstaller(body.installer, ctx.installerOrigin);
  if (body.installer !== undefined && installer === null) {
    console.warn("handoff: the installer's details are not for its own origin; not kept");
  }
  const baseUrl = apiBaseOption(env).baseUrl;
  const clock = deps.now;
  const { connection, finished: code } = await connectGrantStep(
    {
      db: env.DB,
      // Counted above, before the secret was checked.
      client: null,
      now,
      claimCookie: undefined,
      authSecretBound:
        typeof env.BETTER_AUTH_SECRET === "string" && env.BETTER_AUTH_SECRET.length > 0,
      selfBound: selfUnits(env) !== undefined,
      ...(deps.generateAuthSecret ? { generateAuthSecret: deps.generateAuthSecret } : {}),
      grant: {
        grant: body.grant,
        accountId: body.accountId,
        host: url.host,
        runningVersionId: env.CF_VERSION_METADATA?.id ?? null,
        ...(env.CF_GRANT_KEY === undefined ? {} : { grantKey: env.CF_GRANT_KEY }),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deps.onRequest === undefined ? {} : { onRequest: deps.onRequest }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(clock === undefined ? {} : { now: () => clock().getTime() }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.memo === undefined ? {} : { memo: deps.memo }),
        ...(deps.generateKey === undefined ? {} : { generateKey: deps.generateKey }),
      },
      // The rotated grant is kept from the first refresh on, so a try that
      // fails before it is stored leaves the next one something to start from.
      // Sealed with the raw secret from this request, which the installer never sees.
      store: (grantDeps) => storeHandedGrant({ ...grantDeps, secret: body.secret, at: now }),
    },
    {
      before: async () => {
        if ((await readHandoffState(env.DB)) !== "waiting") throw new AlreadyReceived();
      },
      finish: async (saved) => {
        await adoptAddress({
          db: env.DB,
          api: saved.api,
          hostname: url.hostname,
          intended: body.intendedAddress ?? null,
          workerName: saved.workerName,
          now,
        });
        const claim = await ownerClaimStatement(env.DB, now);
        const statements = [
          env.DB.prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          ).bind(HANDOFF_RECEIVED_KEY, now.toISOString(), now.getTime()),
          claim.statement,
        ];
        if (installer !== null) {
          statements.push(await installerDetailsStatement(env.DB, ctx.hash, installer, now));
        }
        await env.DB.batch(statements);
        return claim.code;
      },
    },
  );
  console.log(
    `handoff: Cloudflare connected for Worker ${connection.workerName}${connection.resumed ? " (resumed)" : ""}`,
  );
  // What the account can run, for setup's last step; never fails the handoff.
  // The stored grant's scopes say which probes the sign-in may make.
  deps.waitUntil?.(
    readGrant(env.DB)
      .then((grant) =>
        refreshCapabilities(createDb(env.DB), connection.api, {
          version: runningVersion(env),
          signInScopes: grant?.scopes ?? null,
        }),
      )
      .catch((error: unknown) =>
        console.error("capability check after the handoff failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
  );
  return json({ ok: true, ownerSetupUrl: ownerSetupUrl(url, code) }, 200, cors);
}

/**
 * When the handoff arrives on a custom domain attached to this Worker, that
 * domain becomes Appflare's address, as if Appflare had moved there: the
 * workers.dev address then redirects to it, and passkeys are made for it.
 * When it arrives at workers.dev while the Worker has the custom domain the
 * install chose (`intended`, or its only one), that domain does not serve
 * yet: it is recorded as pending, and Appflare moves there by itself once
 * it serves (domains/pending-address.server.ts). On any other hostname
 * nothing changes. Best effort: Domains settings can do it later.
 */
async function adoptAddress(deps: {
  db: D1Database;
  api: CloudflareClient;
  hostname: string;
  intended: string | null;
  workerName: string;
  now: Date;
}): Promise<void> {
  const hostname = deps.hostname.toLowerCase();
  if (hostname.endsWith(".workers.dev")) {
    try {
      const pending = await recordPendingAddress(deps);
      if (pending !== null) {
        console.log(`address: Appflare moves to ${pending.hostname} once it serves`);
      }
    } catch (error) {
      console.error("handoff: could not record the pending address", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (hostname === "localhost" || /^[\d.]+$/.test(hostname)) return;
  try {
    const domains = await deps.api.workerDomains.listDomains({ hostname });
    const domain = domains.find(
      (d) => d.hostname.toLowerCase() === hostname && d.service === deps.workerName,
    );
    if (domain === undefined) {
      console.warn(`handoff: ${hostname} is not a custom domain of this Worker; address unchanged`);
      return;
    }
    await completeAddressMove(
      { db: deps.db, api: deps.api, now: () => deps.now },
      {
        hostname,
        domainId: domain.id,
        zoneId: domain.zone_id,
        workerName: deps.workerName,
        inUse: hostname,
      },
    );
    console.log(`address: Appflare lives at ${hostname}`);
  } catch (error) {
    console.error("handoff: could not record Appflare's address", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Seconds the installing page waits before trying again after a 503. */
const RETRY_AFTER_S = 30;

function busy(message: string, cors: Headers): Response {
  const headers = new Headers(cors);
  headers.set("retry-after", String(RETRY_AFTER_S));
  return refusal("busy", message, 503, headers);
}

/**
 * A refused or failed first handoff, as a status the installing page acts on:
 * - 409 `done`: an owner exists.
 * - 409 `setup_elsewhere` (with `minutes`): another browser is finishing
 *   setup with an API token; try again once its claim runs out.
 * - 401 `authorize_again`: the browser's authorization was used up by an
 *   earlier try and none is kept here; sign in to Cloudflare again and hand
 *   over the new one.
 * - 429: too many tries from this address.
 * - 503 `busy` (with `Retry-After`): a lock, or Cloudflare not answering;
 *   the same request works later.
 * - 400 `refused`: the authorization cannot be used here (another account,
 *   missing permissions); trying again does not help.
 * - 502/500 `failed`: a Cloudflare call or this Worker failed; try again.
 */
function failure(error: unknown, cors: Headers): Response {
  if (error instanceof AuthorizeAgain) {
    return refusal("authorize_again", error.message, 401, cors);
  }
  if (error instanceof SetupError) {
    switch (error.reason) {
      case "done":
        return json({ error: "done", message: HANDOFF_MESSAGES.done }, 409, cors);
      case "rate-limited":
        return refusal("rate_limited", error.message, 429, cors);
      case "in-progress":
        return json(
          { error: "setup_elsewhere", message: error.message, minutes: error.minutes },
          409,
          cors,
        );
      case "busy":
        return busy(error.message, cors);
      default:
        return refusal("refused", error.message, 400, cors);
    }
  }
  if (error instanceof GrantStoreError) {
    return isTemporaryGrantFailure(error)
      ? busy(error.message, cors)
      : refusal("refused", error.message, 400, cors);
  }
  if (error instanceof CloudflareConnectionError) {
    return error.retryable
      ? busy(error.message, cors)
      : refusal("refused", error.message, 400, cors);
  }
  if (error instanceof CloudflareApiError) {
    // Method, path and status only; never a token.
    console.error("handoff: a Cloudflare call failed", { error: error.message });
    return refusal("failed", HANDOFF_MESSAGES.failed, 502, cors);
  }
  console.error("handoff: failed", {
    error: error instanceof Error ? error.name : "unknown",
  });
  return refusal("failed", HANDOFF_MESSAGES.failed, 500, cors);
}
