import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CloudflareApiError, createClient, type FetchLike } from "@appflare/cf-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { ACC } from "../test/fake-account";
import { fakeCloudflare } from "../test/fake-cloudflare";
import { fakeOAuth } from "../test/fake-oauth";
import { CfTokenNotConfiguredError, getCfClient } from "./client.server";
import {
  type ConnectionMemo,
  cloudflareConnection,
  connectionProblem,
  createConnectionMemo,
  holdGrantForRemoval,
  isolateConnectionMemo,
  LOCK_POLL_MS,
  LOCK_POLLS,
  REFRESH_WORST_CASE_MS,
} from "./connection.server";
import { CloudflareConnectionError } from "./connection-errors";
import { generateGrantKey, importGrantKey, openValue, sealContext, sealValue } from "./grant-seal";
import { type GrantRow, readGrant, replaceGrantStatements } from "./grant-store.server";

/**
 * The connection where requests meet: a refresh that outlives its lease, a
 * grant replaced while a refresh waits, a renewal D1 would not store, an
 * access token the API refuses, and the switch from a grant to an API token
 * while the version with the token rolls out.
 */

const START = 1_790_000_000_000;
const CLIENT = "client-races";
const REFRESH = "cf-refresh-SECRET-seed";
const SCRIPTS = `GET /accounts/${ACC}/workers/scripts`;

let clock = START;
const now = () => clock;
const quickSleep = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
let keySecret = "";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  clock = START;
  keySecret = generateGrantKey();
  const shared = isolateConnectionMemo();
  Object.assign(shared, createConnectionMemo());
});

afterEach(() => vi.restoreAllMocks());

async function key() {
  const imported = await importGrantKey(keySecret);
  if (imported === null) throw new Error("test key did not import");
  return imported;
}

/** A grant whose access token has run out (or is `access`, lasting an hour). */
async function seedGrant(over: { id?: string; refresh?: string; access?: string } = {}) {
  const k = await key();
  const id = over.id ?? "grant-1";
  const row: GrantRow = {
    id,
    clientId: CLIENT,
    scopes: [],
    refreshToken: await sealValue(k.key, over.refresh ?? REFRESH, sealContext(id, "refresh")),
    accessToken:
      over.access === undefined
        ? null
        : await sealValue(k.key, over.access, sealContext(id, "access")),
    accessExpiresAt: over.access === undefined ? null : START + 60 * 60_000,
    keyId: k.id,
    status: "connected",
    problem: null,
    problemAt: null,
    connectedAt: START - 86_400_000,
    refreshedAt: START - 60_000,
  };
  await env.DB.batch(replaceGrantStatements(env.DB, row));
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.cfTokenConfigured]: "1",
  });
  return row;
}

async function stored(): Promise<{ status: string; refresh: string; hasAccess: boolean }> {
  const row = await readGrant(env.DB);
  if (row === null) throw new Error("no grant");
  return {
    status: row.status,
    refresh: await openValue((await key()).key, row.refreshToken, sealContext(row.id, "refresh")),
    hasAccess: row.accessToken !== null,
  };
}

function connection(
  fetch: FetchLike,
  opts: { memo?: ConnectionMemo; grant?: GrantRow | null; env?: Record<string, string> } = {},
) {
  return cloudflareConnection(
    { DB: env.DB, CF_GRANT_KEY: keySecret, ...opts.env },
    { fetch, now, sleep: quickSleep, memo: opts.memo ?? createConnectionMemo() },
    opts.grant === undefined ? undefined : { grant: opts.grant },
  );
}

describe("a refresh that outlives its lease", () => {
  it("leaves the grant connected with the tokens it got, even after another request was refused meanwhile", async () => {
    await seedGrant();
    const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
    const oauth = fakeOAuth(api.fetch);
    // A's refresh hangs; B's, sent after A's lease ran out, is refused
    // because A's request already used (and rotated) the refresh token.
    oauth.next.push("hold", "invalid_grant");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = connection(oauth.fetch).token();
    await oauth.held();
    clock += 61_000;
    const b = await connection(oauth.fetch)
      .token()
      .catch((e: unknown) => e);
    expect((b as CloudflareConnectionError).problem).toBe("needs_reconnect");
    expect((await stored()).status).toBe("needs_reconnect");
    oauth.release();
    expect(await a).toBe("cf-access-SECRET-1");
    expect(await stored()).toEqual({
      status: "connected",
      refresh: "cf-refresh-SECRET-1",
      hasAccess: true,
    });
    expect(oauth.refreshes.map((r) => r.refreshToken)).toEqual([REFRESH, REFRESH]);
    // A third request uses A's tokens; nothing refreshes again.
    expect(await connection(oauth.fetch).token()).toBe("cf-access-SECRET-1");
    expect(oauth.refreshes).toHaveLength(2);
  });

  it("a late answer never overwrites the rotation another request stored meanwhile", async () => {
    await seedGrant();
    const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
    const oauth = fakeOAuth(api.fetch);
    // A's refresh hangs past its lease; B refreshes and stores; then A's
    // answer arrives.
    oauth.next.push("hold", "rotate");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = connection(oauth.fetch).token();
    await oauth.held();
    clock += 61_000;
    expect(await connection(oauth.fetch).token()).toBe("cf-access-SECRET-1");
    expect((await stored()).refresh).toBe("cf-refresh-SECRET-1");
    oauth.release();
    // A's answer came late: its tokens are not stored over B's newer rotation.
    expect(await a).toBe("cf-access-SECRET-2");
    expect(await stored()).toEqual({
      status: "connected",
      refresh: "cf-refresh-SECRET-1",
      hasAccess: true,
    });
  });
});

describe("a grant replaced while a refresh waits for the lease", () => {
  it("is resolved with the lease already held, never by waiting for itself", async () => {
    const first = await seedGrant({ id: "grant-old" });
    const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
    const oauth = fakeOAuth(api.fetch);
    const conn = connection(oauth.fetch, { grant: first });
    // An administrator reconnected: the new grant's access token has run out too.
    await seedGrant({ id: "grant-new", refresh: "cf-refresh-SECRET-new" });
    expect(await conn.token()).toBe("cf-access-SECRET-1");
    expect(oauth.refreshes.map((r) => r.refreshToken)).toEqual(["cf-refresh-SECRET-new"]);
  });
});

describe("a renewal D1 would not store", () => {
  it("is kept in the isolate and stored on the next resolution, before any refresh", async () => {
    await seedGrant();
    const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
    const oauth = fakeOAuth(api.fetch);
    const memo = createConnectionMemo();
    const real = env.DB.prepare.bind(env.DB);
    let failures = 2;
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("UPDATE cloudflare_grant SET refresh_token") && failures > 0) {
        failures -= 1;
        throw new Error("D1_ERROR: storage unavailable");
      }
      return real(sql);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await connection(oauth.fetch, { memo })
      .token()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareConnectionError);
    expect((error as CloudflareConnectionError).retryable).toBe(true);
    expect((error as Error).message).not.toContain("D1_ERROR");
    expect(memo.pending).not.toBeNull();
    expect((await stored()).refresh).toBe(REFRESH);
    // The next resolution stores it first, and uses its access token.
    expect(await connection(oauth.fetch, { memo }).token()).toBe("cf-access-SECRET-1");
    expect(memo.pending).toBeNull();
    expect((await stored()).refresh).toBe("cf-refresh-SECRET-1");
    expect(oauth.refreshes).toHaveLength(1);
  });

  it("a forced renewal while it is still unstored sends its refresh token, never the used one in D1", async () => {
    await seedGrant();
    const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
    const oauth = fakeOAuth(api.fetch);
    const memo = createConnectionMemo();
    const writes = failRenewalWrites();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await connection(oauth.fetch, { memo })
      .token()
      .catch(() => {});
    expect(memo.pending).not.toBeNull();
    // Removal wants a token that lasts longer than the one held: a refresh
    // is forced while the flush keeps failing.
    const held = await holdGrantForRemoval(
      { DB: env.DB, CF_GRANT_KEY: keySecret },
      2 * 60 * 60_000,
      { fetch: oauth.fetch, now, sleep: quickSleep, memo },
    );
    expect(oauth.refreshes.map((r) => r.refreshToken)).toEqual([REFRESH, "cf-refresh-SECRET-1"]);
    // What removal revokes is the newest refresh token, still only in memory.
    expect(held?.refreshToken).toBe("cf-refresh-SECRET-2");
    expect((await stored()).refresh).toBe(REFRESH);
    // D1 answers again: the newest renewal is stored, over the token D1 held.
    writes.stop();
    expect(await connection(oauth.fetch, { memo }).token()).toBe("cf-access-SECRET-2");
    expect(memo.pending).toBeNull();
    expect((await stored()).refresh).toBe("cf-refresh-SECRET-2");
    expect(oauth.refreshes).toHaveLength(2);
  });

  it("a flush that finishes keeps a newer renewal kept while it was out", async () => {
    const memo = createConnectionMemo();
    const renewal = {
      refreshToken: "x",
      accessToken: "y",
      accessExpiresAt: 1,
      scopes: null,
      at: 1,
    };
    const older = { grantId: "grant-gone", sent: "sealed-1", renewal };
    const newer = { grantId: "grant-gone", sent: "sealed-2", renewal };
    memo.pending = older;
    const real = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("UPDATE cloudflare_grant SET refresh_token")) memo.pending = newer;
      return real(sql);
    });
    const conn = cloudflareConnection(
      { DB: env.DB, CF_API_TOKEN: "cf-api-SECRET" },
      { memo },
      {
        grant: null,
      },
    );
    expect(await conn.token()).toBe("cf-api-SECRET");
    expect(memo.pending).toBe(newer);
  });
});

/** Makes every write of renewed tokens fail until `stop()`. */
function failRenewalWrites(): { stop(): void } {
  let failing = true;
  const real = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
    if (failing && sql.startsWith("UPDATE cloudflare_grant SET refresh_token")) {
      throw new Error("D1_ERROR: storage unavailable");
    }
    return real(sql);
  });
  return {
    stop() {
      failing = false;
    },
  };
}

describe("waiting for another request's refresh", () => {
  it("lasts longer than the slowest refresh, then ends as temporary", () => {
    expect(REFRESH_WORST_CASE_MS).toBe(32_000);
    expect(LOCK_POLLS * LOCK_POLL_MS).toBeGreaterThan(REFRESH_WORST_CASE_MS + 10_000);
  });
});

describe("an access token the API refuses (401)", () => {
  /** The REST API, refusing `refused` with 401 and answering every other token. */
  function api(refused: readonly string[]) {
    const calls: string[] = [];
    const fetch: FetchLike = async (_input, init) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      calls.push(auth);
      if (refused.some((t) => auth === `Bearer ${t}`)) {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
            result: null,
          },
          { status: 401 },
        );
      }
      return Response.json({ success: true, errors: [], messages: [], result: [] });
    };
    return { fetch, calls };
  }

  function client(fetch: FetchLike, memo = createConnectionMemo()) {
    const conn = connection(fetch, { memo });
    return createClient({ accountId: ACC, token: conn.token, fetch: conn.retrying(fetch) });
  }

  it("renews once and sends the request again", async () => {
    await seedGrant({ access: "cf-access-SECRET-withdrawn" });
    const rest = api(["cf-access-SECRET-withdrawn"]);
    const oauth = fakeOAuth(rest.fetch);
    await client(oauth.fetch).workers.listScripts();
    expect(rest.calls).toEqual(["Bearer cf-access-SECRET-withdrawn", "Bearer cf-access-SECRET-1"]);
    expect(oauth.refreshes).toHaveLength(1);
  });

  it("does not renew for Containers' refusal on Workers Free, which is about the plan", async () => {
    await seedGrant({ access: "cf-access-SECRET-good" });
    const calls: string[] = [];
    // As recorded live on a Workers Free account, for any credential.
    const containers: FetchLike = async (_input, init) => {
      calls.push(new Headers(init?.headers).get("Authorization") ?? "");
      return Response.json(
        {
          success: false,
          errors: [
            {
              code: 1000,
              message:
                '{"error":"Unauthorized: You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan."}',
            },
          ],
          result: null,
        },
        { status: 401 },
      );
    };
    const oauth = fakeOAuth(containers);
    const error = await client(oauth.fetch)
      .containers.listApplications({ name: "probe" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).errors[0]?.message).toContain("Workers Paid");
    expect(calls).toEqual(["Bearer cf-access-SECRET-good"]);
    expect(oauth.refreshes).toHaveLength(0);
  });

  it("still renews once for a 401 naming Workers Paid outside the Containers API", async () => {
    await seedGrant({ access: "cf-access-SECRET-withdrawn" });
    const calls: string[] = [];
    const rest: FetchLike = async (_input, init) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      calls.push(auth);
      if (auth === "Bearer cf-access-SECRET-withdrawn") {
        return Response.json(
          {
            success: false,
            errors: [{ code: 1000, message: "This needs the Workers Paid plan." }],
            result: null,
          },
          { status: 401 },
        );
      }
      return Response.json({ success: true, errors: [], messages: [], result: [] });
    };
    const oauth = fakeOAuth(rest);
    await client(oauth.fetch).workers.listScripts();
    expect(calls).toEqual(["Bearer cf-access-SECRET-withdrawn", "Bearer cf-access-SECRET-1"]);
    expect(oauth.refreshes).toHaveLength(1);
  });

  it("ends in the reconnect message when the grant itself was withdrawn", async () => {
    await seedGrant({ access: "cf-access-SECRET-withdrawn" });
    const rest = api(["cf-access-SECRET-withdrawn"]);
    const oauth = fakeOAuth(rest.fetch);
    oauth.next.push("invalid_grant");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await client(oauth.fetch)
      .workers.listScripts()
      .catch((e: unknown) => e);
    expect((error as CloudflareConnectionError).problem).toBe("needs_reconnect");
    expect(oauth.refreshes).toHaveLength(1);
    expect(rest.calls).toHaveLength(1);
  });

  it("never loops: a token the API keeps refusing is passed on after one renewal", async () => {
    await seedGrant({ access: "cf-access-SECRET-a" });
    const rest = api(["cf-access-SECRET-a", "cf-access-SECRET-1"]);
    const oauth = fakeOAuth(rest.fetch);
    const memo = createConnectionMemo();
    const first = await client(oauth.fetch, memo)
      .workers.listScripts()
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(CloudflareApiError);
    expect((first as CloudflareApiError).status).toBe(401);
    // The next request soon after does not renew again.
    await client(oauth.fetch, memo)
      .workers.listScripts()
      .catch(() => {});
    expect(oauth.refreshes).toHaveLength(1);
    expect(rest.calls).toHaveLength(3);
  });

  it("renews from a renewal D1 would not store, when the API refuses its access token", async () => {
    await seedGrant();
    const rest = api(["cf-access-SECRET-1"]);
    const oauth = fakeOAuth(rest.fetch);
    const memo = createConnectionMemo();
    const writes = failRenewalWrites();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The first renewal (of the seed) cannot be stored.
    await connection(oauth.fetch, { memo })
      .token()
      .catch(() => {});
    // Its access token is refused; the flush fails again; the forced renewal
    // sends the newest refresh token, which only this isolate holds.
    const error = await client(oauth.fetch, memo)
      .workers.listScripts()
      .catch((e: unknown) => e);
    expect((error as CloudflareConnectionError).problem).toBe("temporary");
    expect(oauth.refreshes.map((r) => r.refreshToken)).toEqual([REFRESH, "cf-refresh-SECRET-1"]);
    writes.stop();
    await client(oauth.fetch, memo).workers.listScripts();
    expect((await stored()).refresh).toBe("cf-refresh-SECRET-2");
    expect(rest.calls.at(-1)).toBe("Bearer cf-access-SECRET-2");
    expect(oauth.refreshes).toHaveLength(2);
  });

  it("never hands a refused token out again, so a renewal that fails for now says so", async () => {
    await seedGrant({ access: "cf-access-SECRET-withdrawn" });
    const rest = api(["cf-access-SECRET-withdrawn"]);
    const oauth = fakeOAuth(rest.fetch);
    const memo = createConnectionMemo();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    oauth.next.push({ status: 503 }, { status: 503 }, { status: 503 });
    const first = await client(oauth.fetch, memo)
      .workers.listScripts()
      .catch((e: unknown) => e);
    expect((first as CloudflareConnectionError).problem).toBe("temporary");
    // A plain resolution right after does not pick the refused token back up from D1.
    oauth.next.push({ status: 503 }, { status: 503 }, { status: 503 });
    const second = await connection(oauth.fetch, { memo })
      .token()
      .catch((e: unknown) => e);
    expect((second as CloudflareConnectionError).problem).toBe("temporary");
    expect(oauth.refreshes).toHaveLength(6);
    expect(rest.calls).toEqual(["Bearer cf-access-SECRET-withdrawn"]);
  });

  it("leaves an API token connection's 401 alone", async () => {
    const rest = api(["cf-api-SECRET"]);
    const conn = cloudflareConnection(
      { DB: env.DB, CF_API_TOKEN: "cf-api-SECRET" },
      { memo: createConnectionMemo() },
    );
    const cf = createClient({
      accountId: ACC,
      token: conn.token,
      fetch: conn.retrying(rest.fetch),
    });
    await expect(cf.workers.listScripts()).rejects.toBeInstanceOf(CloudflareApiError);
    expect(rest.calls).toHaveLength(1);
  });
});

describe("switching from a grant to an API token", () => {
  it("while the version with the token rolls out, a request is told to try again, not to finish setup", async () => {
    // The grant is gone and Appflare has a connection, but this version has no token yet.
    await writeSettings(createDb(env.DB), {
      [SETTING.accountId]: ACC,
      [SETTING.cfTokenConfigured]: "1",
    });
    const problem = await connectionProblem({ DB: env.DB, CF_GRANT_KEY: keySecret });
    expect(problem?.problem).toBe("redeploying");
    expect(problem?.retryable).toBe(true);
    const error = await connection(fakeCloudflare({}).fetch)
      .token()
      .catch((e: unknown) => e);
    expect((error as CloudflareConnectionError).problem).toBe("redeploying");
    const fromClient = await getCfClient({ DB: env.DB }).catch((e: unknown) => e);
    expect((fromClient as CloudflareConnectionError).problem).toBe("redeploying");
  });

  it("a provider that knew the grant, finding it gone, says the same", async () => {
    const row = await seedGrant();
    const conn = connection(fakeOAuth(fakeCloudflare({}).fetch).fetch, { grant: row });
    await env.DB.prepare("DELETE FROM cloudflare_grant").run();
    const error = await conn.token().catch((e: unknown) => e);
    expect((error as CloudflareConnectionError).problem).toBe("redeploying");
  });

  it("before any connection was set up, it is still 'finish setup first'", async () => {
    const problem = await connectionProblem({ DB: env.DB });
    expect(problem?.problem).toBe("not_configured");
    await expect(getCfClient({ DB: env.DB })).rejects.toBeInstanceOf(CfTokenNotConfiguredError);
  });
});
