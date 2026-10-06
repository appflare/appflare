import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  CLOUDFLARE_OAUTH_AUTHORIZE_URL,
  CLOUDFLARE_OAUTH_TOKEN_URL,
  decodeOAuthState,
  type FetchLike,
  MANAGER_OAUTH_API_SCOPES,
  MANAGER_OAUTH_SCOPES,
  pkceChallenge,
} from "@appflare/cf-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { rotateTokenStep } from "../server/token.server";
import { ACC } from "../test/fake-account";
import { type FakeRoute, fakeCloudflare } from "../test/fake-cloudflare";
import { fakeOAuth } from "../test/fake-oauth";
import { createConnectionMemo, readConnectionState } from "./connection.server";
import { storeGrant } from "./grant.server";
import { generateGrantKey, grantKeyId } from "./grant-seal";
import { readGrant } from "./grant-store.server";
import { APPFLARE_OAUTH_CLIENT_ID } from "./oauth-client";
import {
  handleOAuthReturn,
  OAUTH_RETURN_PATH,
  RECONNECT_MESSAGES,
  RECONNECT_TTL_MS,
  RETURN_RATE_LIMIT,
  startReconnect,
} from "./reconnect.server";
import { type ReconnectOutcome, reconnectOutcomeHref } from "./reconnect-outcome";

/**
 * Reconnecting Cloudflare with Cloudflare sign-in: the start an administrator
 * makes, and the form appflare.dev's callback page posts back. Cloudflare's
 * REST API and OAuth endpoints are fakes; every credential they issue says
 * SECRET, so a leak shows up in a search.
 */

const A = `/accounts/${ACC}`;
const START = 1_790_000_000_000;
const VERSION = "11111111-2222-4333-8444-555555555555";
const HOST = "appflare.appflare-dev.workers.dev";
const ORIGIN = `https://${HOST}`;
const CODE = "cf-code-SECRET-from-cloudflare";
const ADMIN = "user-admin";
const MEMBER = "user-member";
const OLD_TOKEN = "cf-api-token-SECRET-old";

const ok = (result: unknown): FakeRoute => ({ result });

function routes(over: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  return {
    "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
    [`GET ${A}/workers/scripts`]: ok([{ id: "appflare" }, { id: "cut" }]),
    [`GET ${A}/workers/scripts/appflare/versions/${VERSION}`]: ok({ id: VERSION }),
    [`PUT ${A}/workers/scripts/appflare/secrets`]: ok({ name: "x", type: "secret_text" }),
    [`DELETE ${A}/workers/scripts/appflare/secrets/CF_API_TOKEN`]: ok(null),
    ...over,
  };
}

interface Exchange {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
}

/**
 * The fakes, with the code exchange in front: `exchangeAnswer` is the token
 * endpoint's answer to `grant_type=authorization_code`; refreshes and
 * revocations go to the OAuth fake, the rest to the API fake.
 */
function world(
  options: { over?: Record<string, FakeRoute>; exchangeAnswer?: () => Response } = {},
) {
  const api = fakeCloudflare(routes(options.over));
  const oauth = fakeOAuth(api.fetch);
  const exchanges: Exchange[] = [];
  const fetch: FetchLike = async (input, init) => {
    if (input === CLOUDFLARE_OAUTH_TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (form.get("grant_type") === "authorization_code") {
        exchanges.push({
          code: form.get("code") ?? "",
          verifier: form.get("code_verifier") ?? "",
          redirectUri: form.get("redirect_uri") ?? "",
          clientId: form.get("client_id") ?? "",
        });
        return (
          options.exchangeAnswer?.() ??
          Response.json({
            access_token: "cf-access-SECRET-code",
            refresh_token: "cf-refresh-SECRET-code",
            expires_in: 3600,
            scope: MANAGER_OAUTH_SCOPES.join(" "),
          })
        );
      }
    }
    return oauth.fetch(input, init);
  };
  return { api, oauth, exchanges, fetch };
}

type World = ReturnType<typeof world>;

let logs: string[] = [];

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.accountName]: "Appflare Dev",
    [SETTING.workerName]: "appflare",
    [SETTING.cfTokenConfigured]: "1",
  });
  for (const [id, role] of [
    [ADMIN, "admin"],
    [MEMBER, "member"],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at, role, banned)
       VALUES (?1, ?1, ?2, 0, ?3, ?3, ?4, 0)`,
    )
      .bind(id, `${id}@example.com`, START, role)
      .run();
  }
  logs = [];
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => vi.restoreAllMocks());

async function start(over: Partial<Parameters<typeof startReconnect>[0]> = {}) {
  const started = await startReconnect({
    db: env.DB,
    userId: ADMIN,
    origin: ORIGIN,
    config: {},
    now: () => START,
    ...over,
  });
  const url = new URL(started.url);
  return { started, url, state: url.searchParams.get("state") ?? "" };
}

function returnRequest(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${OAUTH_RETURN_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // The callback page sends no referrer, so the browser says `Origin: null`.
      origin: "null",
      "cf-connecting-ip": "203.0.113.9",
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function returnDeps(w: World, over: Partial<Parameters<typeof handleOAuthReturn>[2]> = {}) {
  return {
    runningVersionId: VERSION,
    fetch: w.fetch,
    now: () => START + 60_000,
    sleep: async () => {},
    memo: createConnectionMemo(),
    generateKey: generateGrantKey,
    ...over,
  };
}

function outcomeOf(response: Response): string | null {
  expect(response.status).toBe(303);
  return response.headers.get("location");
}

const at = (outcome: ReconnectOutcome) => reconnectOutcomeHref(outcome);

describe("startReconnect", () => {
  it("asks for every manager permission, returning to this manager's address", async () => {
    const { started, url, state } = await start();
    expect(`${url.origin}${url.pathname}`).toBe(CLOUDFLARE_OAUTH_AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe(APPFLARE_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://appflare.dev/deploy/callback");
    expect(url.searchParams.get("scope")).toBe(MANAGER_OAUTH_SCOPES.join(" "));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(decodeOAuthState(state)).toMatchObject({ v: 1, k: "reconnect", o: ORIGIN });
    expect(started.origin).toBe(ORIGIN);
  });

  it("keeps the state only hashed and the verifier sealed, expiring in 10 minutes", async () => {
    const { state } = await start();
    const decoded = decodeOAuthState(state);
    const rows = await env.DB.prepare(
      "SELECT identifier, value, expires_at FROM verification",
    ).all<{
      identifier: string;
      value: string;
      expires_at: number;
    }>();
    expect(rows.results).toHaveLength(1);
    const row = rows.results[0];
    expect(row?.expires_at).toBe(START + RECONNECT_TTL_MS);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(state);
    expect(stored).not.toContain(decoded?.n ?? "missing");
    expect(JSON.parse(row?.value ?? "{}")).toMatchObject({ userId: ADMIN });
  });

  it("uses the stored grant's own client, and a development client otherwise", async () => {
    const dev = await start({
      config: {
        CF_OAUTH_CLIENT_ID: "dev-client",
        CF_OAUTH_CALLBACK_URL: "http://localhost:4321/deploy/callback",
      },
    });
    expect(dev.url.searchParams.get("client_id")).toBe("dev-client");
    expect(dev.url.searchParams.get("redirect_uri")).toBe("http://localhost:4321/deploy/callback");

    const w = world();
    await storeGrant({
      db: env.DB,
      grant: { refreshToken: "cf-refresh-SECRET-x", clientId: "grant-client", scopes: [] },
      accountId: ACC,
      host: HOST,
      runningVersionId: VERSION,
      fetch: w.fetch,
      now: () => START,
      sleep: async () => {},
      memo: createConnectionMemo(),
    });
    const again = await start({ config: { CF_OAUTH_CLIENT_ID: "dev-client" } });
    expect(again.url.searchParams.get("client_id")).toBe("grant-client");
  });

  it("refuses before Cloudflare was ever connected, and an address it cannot return to", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.cfTokenConfigured]: "" });
    await expect(start()).rejects.toThrow(RECONNECT_MESSAGES.notConfigured);
    await writeSettings(createDb(env.DB), { [SETTING.cfTokenConfigured]: "1" });
    await expect(start({ origin: "http://appflare.example.com" })).rejects.toThrow(
      RECONNECT_MESSAGES.badOrigin,
    );
  });
});

describe("handleOAuthReturn", () => {
  it("switches an API token connection to Cloudflare sign-in and deletes the old token", async () => {
    const { url, state } = await start();
    const w = world();
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB, CF_API_TOKEN: OLD_TOKEN },
      returnDeps(w),
    );
    expect(outcomeOf(response)).toBe(at("connected"));
    expect(response.headers.get("location")).toBe(
      "/settings/account?cloudflare=connected#connection",
    );
    // The code went back with the verifier whose challenge Cloudflare saw.
    expect(w.exchanges).toHaveLength(1);
    const [exchange] = w.exchanges;
    expect(exchange).toMatchObject({
      code: CODE,
      clientId: APPFLARE_OAUTH_CLIENT_ID,
      redirectUri: "https://appflare.dev/deploy/callback",
    });
    expect(await pkceChallenge(exchange?.verifier ?? "")).toBe(
      url.searchParams.get("code_challenge"),
    );
    // Stored as the connection; the old token is gone from the Worker.
    expect((await readGrant(env.DB))?.status).toBe("connected");
    const deleted = w.api.calls.find(
      (c) => c.key === `DELETE ${A}/workers/scripts/appflare/secrets/CF_API_TOKEN`,
    );
    expect(deleted?.authorization).toMatch(/^Bearer cf-access-SECRET-/);
    const view = await readConnectionState({ DB: env.DB }, { memo: createConnectionMemo() });
    expect(view.kind).toBe("oauth");
  });

  it("works once: the same state again is expired, and changes nothing", async () => {
    const { state } = await start();
    const w = world();
    const first = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(outcomeOf(first)).toBe(at("connected"));
    const again = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(outcomeOf(again)).toBe(at("expired"));
    expect(w.exchanges).toHaveLength(1);
  });

  it("refuses a sign-in older than 10 minutes without exchanging the code", async () => {
    const { state } = await start();
    const w = world();
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB },
      returnDeps(w, { now: () => START + RECONNECT_TTL_MS }),
    );
    expect(outcomeOf(response)).toBe(at("expired"));
    expect(w.exchanges).toHaveLength(0);
    expect(await readGrant(env.DB)).toBeNull();
    // Taken out all the same.
    expect((await env.DB.prepare("SELECT count(*) AS n FROM verification").first())?.n).toBe(0);
  });

  it("refuses a state it did not start, or one that is not a reconnect", async () => {
    await start();
    const w = world();
    const forged = Buffer.from(
      JSON.stringify({ v: 1, n: "n".repeat(43), k: "reconnect", o: ORIGIN }),
    ).toString("base64url");
    const install = Buffer.from(JSON.stringify({ v: 1, n: "n".repeat(43), k: "install" })).toString(
      "base64url",
    );
    for (const state of [forged, install, "not-a-state"]) {
      const response = await handleOAuthReturn(
        returnRequest({ code: CODE, state }),
        { DB: env.DB },
        returnDeps(w),
      );
      expect(outcomeOf(response)).toBe(at("expired"));
    }
    expect(w.exchanges).toHaveLength(0);
    // The real one is still waiting.
    expect((await env.DB.prepare("SELECT count(*) AS n FROM verification").first())?.n).toBe(1);
  });

  it("answers a request that is not the callback's form with a plain refusal", async () => {
    const w = world();
    const json = await handleOAuthReturn(
      new Request(`${ORIGIN}${OAUTH_RETURN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: CODE, state: "x" }),
      }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(json.status).toBe(415);
    const noState = await handleOAuthReturn(
      returnRequest({ code: CODE }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(noState.status).toBe(400);
    const twice = await handleOAuthReturn(
      new Request(`${ORIGIN}${OAUTH_RETURN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "code=a&code=b&state=s",
      }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(twice.status).toBe(400);
    const get = await handleOAuthReturn(
      new Request(`${ORIGIN}${OAUTH_RETURN_PATH}?code=${CODE}&state=s`),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(get.status).toBe(405);
  });

  it("says when consent was refused at Cloudflare, using up the sign-in", async () => {
    const { state } = await start();
    const w = world();
    const response = await handleOAuthReturn(
      returnRequest({ error: "access_denied", state }),
      { DB: env.DB, CF_API_TOKEN: OLD_TOKEN },
      returnDeps(w),
    );
    expect(outcomeOf(response)).toBe(at("declined"));
    expect(w.exchanges).toHaveLength(0);
    expect(await readGrant(env.DB)).toBeNull();
    // Nothing switches on a failure: the API token stays.
    expect(w.api.keys()).not.toContain(`DELETE ${A}/workers/scripts/appflare/secrets/CF_API_TOKEN`);
    const other = await start();
    const failed = await handleOAuthReturn(
      returnRequest({ error: "server_error", state: other.state }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(outcomeOf(failed)).toBe(at("cloudflare-error"));
  });

  it("refuses an authorization for another account, revoking it and keeping the token", async () => {
    const { state } = await start();
    const w = world({
      over: { [`GET ${A}/workers/scripts/appflare/versions/${VERSION}`]: { status: 404 } },
    });
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB, CF_API_TOKEN: OLD_TOKEN },
      returnDeps(w),
    );
    expect(outcomeOf(response)).toBe(at("wrong-account"));
    expect(await readGrant(env.DB)).toBeNull();
    expect(w.oauth.revokes.length).toBeGreaterThan(0);
    expect(w.api.keys()).not.toContain(`DELETE ${A}/workers/scripts/appflare/secrets/CF_API_TOKEN`);
    // Still the same account, the same Worker.
    const settings = await readSettings(createDb(env.DB), [SETTING.accountId]);
    expect(settings.account_id).toBe(ACC);
  });

  it("refuses an authorization a Worker list proves is not this account", async () => {
    const { state } = await start();
    const w = world({ over: { [`GET ${A}/workers/scripts`]: { status: 403 } } });
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(outcomeOf(response)).toBe(at("wrong-account"));
  });

  it("refuses an authorization missing a permission, and revokes it", async () => {
    const { state } = await start();
    const w = world({
      exchangeAnswer: () =>
        Response.json({
          access_token: "cf-access-SECRET-code",
          refresh_token: "cf-refresh-SECRET-code",
          expires_in: 3600,
          scope: [...MANAGER_OAUTH_API_SCOPES.slice(1), "offline_access"].join(" "),
        }),
    });
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(outcomeOf(response)).toBe(at("missing-permissions"));
    expect(w.oauth.revokes).toEqual([
      { clientId: APPFLARE_OAUTH_CLIENT_ID, refreshToken: "cf-refresh-SECRET-code" },
    ]);
    expect(await readGrant(env.DB)).toBeNull();
  });

  it("refuses an authorization without a refresh token", async () => {
    const { state } = await start();
    const w = world({
      exchangeAnswer: () =>
        Response.json({
          access_token: "cf-access-SECRET-code",
          expires_in: 3600,
          scope: MANAGER_OAUTH_API_SCOPES.join(" "),
        }),
    });
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(outcomeOf(response)).toBe(at("missing-permissions"));
    expect(await readGrant(env.DB)).toBeNull();
  });

  it("calls a code Cloudflare refuses expired, and an unanswered exchange unreachable", async () => {
    const refused = world({
      exchangeAnswer: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    const first = await start();
    expect(
      outcomeOf(
        await handleOAuthReturn(
          returnRequest({ code: CODE, state: first.state }),
          { DB: env.DB },
          returnDeps(refused),
        ),
      ),
    ).toBe(at("expired"));
    const down = world({ exchangeAnswer: () => new Response("down", { status: 503 }) });
    const second = await start();
    expect(
      outcomeOf(
        await handleOAuthReturn(
          returnRequest({ code: CODE, state: second.state }),
          { DB: env.DB },
          returnDeps(down),
        ),
      ),
    ).toBe(at("unreachable"));
  });

  it("refuses a sign-in started by someone who is no longer an administrator", async () => {
    const { state } = await start();
    await env.DB.prepare(`UPDATE "user" SET role = 'member' WHERE id = ?1`).bind(ADMIN).run();
    const w = world();
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(outcomeOf(response)).toBe(at("not-allowed"));
    expect(w.exchanges).toHaveLength(0);

    const member = await start({ userId: MEMBER });
    const memberReturn = await handleOAuthReturn(
      returnRequest({ code: CODE, state: member.state }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(outcomeOf(memberReturn)).toBe(at("not-allowed"));

    await env.DB.prepare(`UPDATE "user" SET role = 'admin', banned = 1 WHERE id = ?1`)
      .bind(ADMIN)
      .run();
    const banned = await start();
    const bannedReturn = await handleOAuthReturn(
      returnRequest({ code: CODE, state: banned.state }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(outcomeOf(bannedReturn)).toBe(at("not-allowed"));
    expect(w.exchanges).toHaveLength(0);
  });

  it("brings back a connection that needed reconnecting and revokes the old grant", async () => {
    const key = generateGrantKey();
    await writeSettings(createDb(env.DB), {
      [SETTING.cfGrantKey]: JSON.stringify({ id: await grantKeyId(key), writtenAt: START - 1 }),
    });
    const w = world();
    await storeGrant({
      db: env.DB,
      grantKey: key,
      grant: { refreshToken: "cf-refresh-SECRET-first", clientId: "grant-client", scopes: [] },
      accountId: ACC,
      host: HOST,
      runningVersionId: VERSION,
      fetch: w.fetch,
      now: () => START,
      sleep: async () => {},
      memo: createConnectionMemo(),
    });
    await env.DB.prepare("UPDATE cloudflare_grant SET status = 'needs_reconnect'").run();
    const { url, state } = await start();
    expect(url.searchParams.get("client_id")).toBe("grant-client");
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB, CF_GRANT_KEY: key },
      returnDeps(w),
    );
    expect(outcomeOf(response)).toBe(at("connected"));
    expect(w.oauth.revokes.map((r) => r.refreshToken)).toContain("cf-refresh-SECRET-1");
    expect((await readGrant(env.DB))?.status).toBe("connected");
    // No API token was bound, so none is deleted.
    expect(w.api.keys()).not.toContain(`DELETE ${A}/workers/scripts/appflare/secrets/CF_API_TOKEN`);
  });

  it("stays connected when the old token cannot be removed, and says so", async () => {
    const { state } = await start();
    const w = world({
      over: {
        [`DELETE ${A}/workers/scripts/appflare/secrets/CF_API_TOKEN`]: {
          status: 500,
          errors: [{ code: 10013, message: "internal" }],
        },
      },
    });
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB, CF_API_TOKEN: OLD_TOKEN },
      returnDeps(w),
    );
    expect(outcomeOf(response)).toBe(at("connected-token-kept"));
    expect((await readGrant(env.DB))?.status).toBe("connected");
  });

  /**
   * The database, except that right after `storeGrant` writes the grant (its
   * one batch here), an administrator's API token save takes its place,
   * which deletes the grant (`clearGrantForApiToken`).
   */
  function tokenSavedMeanwhile(): D1Database {
    let saved = false;
    return new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!saved) {
              saved = true;
              await target.prepare("DELETE FROM cloudflare_grant").run();
            }
            return result;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("says the connection changed when a token saved meanwhile replaced the new grant", async () => {
    const { state } = await start();
    const w = world();
    const after = vi.fn(async () => {});
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: tokenSavedMeanwhile(), CF_API_TOKEN: OLD_TOKEN },
      returnDeps(w, { afterConnected: after }),
    );
    expect(outcomeOf(response)).toBe(at("changed-meanwhile"));
    // The token saved meanwhile is the connection: it is not deleted.
    expect(w.api.keys()).not.toContain(`DELETE ${A}/workers/scripts/appflare/secrets/CF_API_TOKEN`);
    expect(await readGrant(env.DB)).toBeNull();
    expect(after).not.toHaveBeenCalled();
  });

  it("says the connection changed on a grant-to-grant reconnect too", async () => {
    const { state } = await start();
    const w = world();
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: tokenSavedMeanwhile() },
      returnDeps(w),
    );
    expect(outcomeOf(response)).toBe(at("changed-meanwhile"));
  });

  it("stops reading a body past 8 KiB, whatever Content-Length says", async () => {
    const { state } = await start();
    const w = world();
    let pulled = 0;
    const chunk = new TextEncoder().encode(`state=${state}&pad=${"x".repeat(1024)}`);
    // A stream with no declared length that would go on for 1 MiB.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await handleOAuthReturn(
      new Request(`${ORIGIN}${OAUTH_RETURN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "10" },
        body,
      }),
      { DB: env.DB },
      returnDeps(w),
    );
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(16 * 1024);
    expect(w.exchanges).toHaveLength(0);
  });

  it("limits returns per network like setup", async () => {
    const w = world();
    const deps = returnDeps(w);
    for (let i = 0; i < RETURN_RATE_LIMIT.max; i++) {
      const response = await handleOAuthReturn(
        returnRequest({ code: CODE, state: "unknown" }),
        { DB: env.DB },
        deps,
      );
      expect(outcomeOf(response)).toBe(at("expired"));
    }
    const { state } = await start();
    const limited = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB },
      deps,
    );
    expect(outcomeOf(limited)).toBe(at("too-many"));
    expect(w.exchanges).toHaveLength(0);
    // Another network is not affected.
    const other = await handleOAuthReturn(
      returnRequest({ code: CODE, state }, { "cf-connecting-ip": "198.51.100.7" }),
      { DB: env.DB },
      deps,
    );
    expect(outcomeOf(other)).toBe(at("connected"));
  });

  it("never logs, stores in plain or sends back the code, the state, the verifier or a token", async () => {
    const { state } = await start();
    const w = world();
    const response = await handleOAuthReturn(
      returnRequest({ code: CODE, state }),
      { DB: env.DB, CF_API_TOKEN: OLD_TOKEN },
      returnDeps(w),
    );
    const verifier = w.exchanges[0]?.verifier ?? "missing";
    const nonce = decodeOAuthState(state)?.n ?? "missing";
    const secrets = [CODE, state, nonce, verifier, OLD_TOKEN, ...w.oauth.issued];
    const location = response.headers.get("location") ?? "";
    const dump = JSON.stringify(
      await Promise.all(
        ["settings", "verification", "cloudflare_grant", "rate_limit"].map(
          async (table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results,
        ),
      ),
    );
    for (const secret of secrets) {
      expect(logs.join("\n")).not.toContain(secret);
      expect(location).not.toContain(secret);
      expect(dump).not.toContain(secret);
    }
    expect(logs.join("\n")).not.toContain("SECRET");
  });
});

describe("switching from Cloudflare sign-in to an API token", () => {
  it("keeps the authorization when the token is not for this account", async () => {
    const key = generateGrantKey();
    await writeSettings(createDb(env.DB), {
      [SETTING.cfGrantKey]: JSON.stringify({ id: await grantKeyId(key), writtenAt: START - 1 }),
    });
    const w = world({ over: { [`GET ${A}/tokens/verify`]: { status: 401 } } });
    await storeGrant({
      db: env.DB,
      grantKey: key,
      grant: { refreshToken: "cf-refresh-SECRET-first", clientId: "grant-client", scopes: [] },
      accountId: ACC,
      host: HOST,
      runningVersionId: VERSION,
      fetch: w.fetch,
      now: () => START,
      sleep: async () => {},
      memo: createConnectionMemo(),
    });
    const error = await rotateTokenStep({
      db: env.DB,
      token: "cf-api-token-SECRET-other-account",
      host: HOST,
      grantKey: key,
      fetch: w.fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // Verified first: nothing was stored, nothing was revoked.
    expect((await readGrant(env.DB))?.status).toBe("connected");
    expect(w.oauth.revokes).toEqual([]);
    const puts = w.api.calls.filter((c) => c.key === `PUT ${A}/workers/scripts/appflare/secrets`);
    expect(puts.map((c) => JSON.parse(c.body ?? "{}").name)).not.toContain("CF_API_TOKEN");
  });
});
