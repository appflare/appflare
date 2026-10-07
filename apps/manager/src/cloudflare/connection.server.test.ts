import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient, type FetchLike } from "@appflare/cf-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { ACC } from "../test/fake-account";
import { fakeCloudflare } from "../test/fake-cloudflare";
import { FAKE_ACCESS_TTL_S, fakeOAuth } from "../test/fake-oauth";
import { getCfClient } from "./client.server";
import {
  ACCESS_SAFETY_MARGIN_MS,
  type ConnectionMemo,
  cloudflareCredential,
  connectionNeedsReconnecting,
  connectionProblem,
  createConnectionMemo,
  isolateConnectionMemo,
  KEY_REDEPLOY_WINDOW_MS,
  readConnectionState,
} from "./connection.server";
import { CloudflareConnectionError } from "./connection-errors";
import { generateGrantKey, importGrantKey, openValue, sealContext, sealValue } from "./grant-seal";
import { type GrantRow, readGrant, replaceGrantStatements } from "./grant-store.server";

/**
 * The Cloudflare connection's credential provider against a fake token
 * endpoint: where an access token comes from (memo, stored, refreshed), how
 * refreshes are serialized and stored, and what a refused or unanswered
 * refresh leaves behind. Tokens issued here contain "SECRET", so a leak
 * shows up in a search.
 */

const START = 1_790_000_000_000;
const CLIENT = "client-under-test";
const REFRESH = "cf-refresh-SECRET-seed";
const ACCESS = "cf-access-SECRET-seed";
const API_TOKEN = "cf-api-token-SECRET";
const SCRIPTS = `GET /accounts/${ACC}/workers/scripts`;

let clock = START;
const now = () => clock;
const quickSleep = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

let KEY_SECRET = "";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  clock = START;
  KEY_SECRET = generateGrantKey();
  Object.assign(isolateConnectionMemo(), createConnectionMemo());
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function key() {
  const imported = await importGrantKey(KEY_SECRET);
  if (imported === null) throw new Error("test key did not import");
  return imported;
}

/** Stores a grant sealed with the test key, as `storeGrant` would have. */
async function seedGrant(
  over: Partial<GrantRow> & { refresh?: string; access?: string | null } = {},
) {
  const k = await key();
  const id = over.id ?? "grant-1";
  const access = over.access === undefined ? ACCESS : over.access;
  const row: GrantRow = {
    id,
    clientId: CLIENT,
    scopes: ["workers-scripts.write"],
    refreshToken: await sealValue(k.key, over.refresh ?? REFRESH, sealContext(id, "refresh")),
    accessToken: access === null ? null : await sealValue(k.key, access, sealContext(id, "access")),
    accessExpiresAt: START + 60 * 60_000,
    keyId: k.id,
    status: "connected",
    problem: null,
    problemAt: null,
    connectedAt: START - 24 * 60 * 60_000,
    refreshedAt: START - 60_000,
    ...over,
  };
  await env.DB.batch(replaceGrantStatements(env.DB, row));
  await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
  return row;
}

async function storedRefreshToken(): Promise<string> {
  const row = await readGrant(env.DB);
  if (row === null) throw new Error("no grant");
  return openValue((await key()).key, row.refreshToken, sealContext(row.id, "refresh"));
}

function world() {
  const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
  const oauth = fakeOAuth(api.fetch);
  return { api, oauth };
}

function provider(
  fetch: FetchLike,
  opts: { memo?: ConnectionMemo; grantKey?: string | null; apiToken?: string } = {},
) {
  return cloudflareCredential(
    {
      DB: env.DB,
      ...(opts.grantKey === null ? {} : { CF_GRANT_KEY: opts.grantKey ?? KEY_SECRET }),
      ...(opts.apiToken === undefined ? {} : { CF_API_TOKEN: opts.apiToken }),
    },
    { fetch, now, sleep: quickSleep, memo: opts.memo ?? createConnectionMemo() },
  );
}

function client(token: () => Promise<string>, fetch: FetchLike) {
  return createClient({ accountId: ACC, token, fetch });
}

describe("an API token connection", () => {
  it("uses CF_API_TOKEN as before, with no grant and no refresh", async () => {
    const { api, oauth } = world();
    const token = provider(oauth.fetch, { apiToken: API_TOKEN, grantKey: null });
    const cf = client(token, oauth.fetch);
    await cf.workers.listScripts();
    await cf.workers.listScripts();
    expect(api.calls.map((c) => c.authorization)).toEqual([
      `Bearer ${API_TOKEN}`,
      `Bearer ${API_TOKEN}`,
    ]);
    expect(oauth.refreshes).toEqual([]);
    expect(await connectionProblem({ DB: env.DB, CF_API_TOKEN: API_TOKEN })).toBeNull();
  });

  it("reads D1 once per provider, not once per call", async () => {
    const { oauth } = world();
    const prepare = vi.spyOn(env.DB, "prepare");
    const cf = client(provider(oauth.fetch, { apiToken: API_TOKEN }), oauth.fetch);
    for (let i = 0; i < 5; i++) await cf.workers.listScripts();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("without a token says so in the words jobs have always used", async () => {
    const { oauth } = world();
    const error = await provider(oauth.fetch, { grantKey: null })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareConnectionError);
    expect((error as CloudflareConnectionError).problem).toBe("not_configured");
    expect((error as Error).message).toBe(
      "the Cloudflare API token is not configured; finish setup first",
    );
  });

  it("is shown as an API token, connected", async () => {
    await writeSettings(createDb(env.DB), {
      [SETTING.cfTokenVerifiedAt]: "2026-10-01T00:00:00.000Z",
    });
    const view = await readConnectionState({ DB: env.DB, CF_API_TOKEN: API_TOKEN });
    expect(view).toEqual({
      kind: "api_token",
      state: "connected",
      problem: null,
      problemAt: null,
      connectedSince: "2026-10-01T00:00:00.000Z",
      ready: true,
      oauth: null,
    });
  });

  it("getCfClient still builds a client on CF_API_TOKEN for the recorded account", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
    const { api } = world();
    const cf = await getCfClient({ DB: env.DB, CF_API_TOKEN: API_TOKEN }, { fetch: api.fetch });
    await cf.workers.listScripts();
    expect(api.calls[0]?.authorization).toBe(`Bearer ${API_TOKEN}`);
  });
});

describe("resolving an OAuth access token", () => {
  it("uses the stored access token while it lasts, then the memo, without refreshing", async () => {
    await seedGrant();
    const { api, oauth } = world();
    const memo = createConnectionMemo();
    const prepare = vi.spyOn(env.DB, "prepare");
    const cf = client(provider(oauth.fetch, { memo }), oauth.fetch);
    for (let i = 0; i < 4; i++) await cf.workers.listScripts();
    expect(api.calls.map((c) => c.authorization)).toEqual(Array(4).fill(`Bearer ${ACCESS}`));
    expect(oauth.refreshes).toEqual([]);
    // One read of the grant; the other calls came from the memo.
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(memo.access).toMatchObject({ grantId: "grant-1", token: ACCESS });
  });

  it("a second provider in the same isolate answers from the memo without opening the grant", async () => {
    await seedGrant();
    const { oauth } = world();
    const memo = createConnectionMemo();
    await provider(oauth.fetch, { memo })();
    // A memo hit needs only the grant's id: it would work even without the key.
    const again = provider(oauth.fetch, { memo, grantKey: null });
    expect(await again()).toBe(ACCESS);
  });

  it("refreshes once the stored token is inside the safety margin, and stores the rotation", async () => {
    await seedGrant({ accessExpiresAt: START + ACCESS_SAFETY_MARGIN_MS - 1 });
    const { api, oauth } = world();
    const cf = client(provider(oauth.fetch), oauth.fetch);
    await cf.workers.listScripts();
    expect(oauth.refreshes).toEqual([{ clientId: CLIENT, refreshToken: REFRESH }]);
    expect(api.calls[0]?.authorization).toBe("Bearer cf-access-SECRET-1");
    expect(await storedRefreshToken()).toBe("cf-refresh-SECRET-1");
    const row = await readGrant(env.DB);
    expect(row).toMatchObject({
      status: "connected",
      accessExpiresAt: START + FAKE_ACCESS_TTL_S * 1000,
      refreshedAt: START,
      problem: null,
    });
    // The lease is gone.
    const lock = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = 'cf_grant_refresh_lock'",
    ).first();
    expect(lock).toBeNull();
  });

  it("refreshes with no stored access token, and keeps the old refresh token when none comes back", async () => {
    await seedGrant({ access: null, accessExpiresAt: null });
    const { oauth } = world();
    oauth.next.push("keep-refresh-token");
    expect(await provider(oauth.fetch)()).toBe("cf-access-SECRET-1");
    expect(await storedRefreshToken()).toBe(REFRESH);
  });

  it("stores the rotated refresh token before it lets go of the refresh lease", async () => {
    await seedGrant({ access: null, accessExpiresAt: null });
    const { oauth } = world();
    const order: string[] = [];
    const real = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("UPDATE cloudflare_grant SET refresh_token")) order.push("store rotation");
      if (sql.startsWith("DELETE FROM settings WHERE key = ?1 AND value = ?2"))
        order.push("release");
      return real(sql);
    });
    await provider(oauth.fetch)();
    expect(order).toEqual(["store rotation", "release"]);
  });

  it("two isolates needing a refresh at once refresh once and share the result", async () => {
    await seedGrant({ access: null, accessExpiresAt: null });
    const { oauth } = world();
    oauth.next.push("hold");
    const first = provider(oauth.fetch, { memo: createConnectionMemo() })();
    await oauth.held();
    const second = provider(oauth.fetch, { memo: createConnectionMemo() })();
    // The second waits on the lease while the first's refresh is out.
    await new Promise((resolve) => setTimeout(resolve, 20));
    oauth.release();
    expect(await Promise.all([first, second])).toEqual([
      "cf-access-SECRET-1",
      "cf-access-SECRET-1",
    ]);
    expect(oauth.refreshes).toHaveLength(1);
    expect(await storedRefreshToken()).toBe("cf-refresh-SECRET-1");
  });

  it("a provider that waited sees the grant another request refreshed and does not refresh again", async () => {
    await seedGrant({ accessExpiresAt: START + 10 * 60_000 });
    const { oauth } = world();
    const a = provider(oauth.fetch, { memo: createConnectionMemo() });
    const b = provider(oauth.fetch, { memo: createConnectionMemo() });
    expect(await a()).toBe(ACCESS);
    expect(await b()).toBe(ACCESS);
    clock += 6 * 60_000;
    expect(await a()).toBe("cf-access-SECRET-1");
    // b's memo still has the old token inside the margin: it reads the grant and finds the new one.
    expect(await b()).toBe("cf-access-SECRET-1");
    expect(oauth.refreshes).toHaveLength(1);
  });
});

describe("a refused or unanswered refresh", () => {
  it("invalid_grant marks the connection as needing reconnecting, with words for the owner", async () => {
    await seedGrant({ access: null, accessExpiresAt: null });
    const { oauth } = world();
    oauth.next.push("invalid_grant");
    const error = await provider(oauth.fetch)().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareConnectionError);
    const failure = error as CloudflareConnectionError;
    expect(failure.problem).toBe("needs_reconnect");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("An administrator must reconnect Cloudflare in");
    expect(failure.message).toContain("(/settings/account#connection)");
    expect(failure.message).toContain("Your apps keep running.");
    expect(await readGrant(env.DB)).toMatchObject({
      status: "needs_reconnect",
      accessToken: null,
      problem: expect.stringContaining("Cloudflare no longer accepts this connection"),
    });
    expect(await connectionNeedsReconnecting({ DB: env.DB, CF_GRANT_KEY: KEY_SECRET })).toBe(true);
  });

  it("makes no further refresh attempt anywhere once the grant needs reconnecting", async () => {
    await seedGrant({ access: null, accessExpiresAt: null });
    const { oauth } = world();
    oauth.next.push("invalid_grant");
    await provider(oauth.fetch)().catch(() => {});
    for (let i = 0; i < 3; i++) {
      const error = await provider(oauth.fetch, { memo: createConnectionMemo() })().catch(
        (e: unknown) => e,
      );
      expect((error as CloudflareConnectionError).problem).toBe("needs_reconnect");
    }
    expect(oauth.refreshes).toHaveLength(1);
    const view = await readConnectionState({ DB: env.DB, CF_GRANT_KEY: KEY_SECRET });
    expect(view).toMatchObject({ kind: "oauth", state: "needs_reconnect", ready: false });
  });

  it.each([
    ["503", { status: 503 }],
    ["429", { status: 429 }],
    ["no answer", "network-error"],
  ] as const)(
    "%s, three times, is temporary and changes nothing but the last problem",
    async (_n, answer) => {
      await seedGrant({ access: null, accessExpiresAt: null });
      const { oauth } = world();
      oauth.next.push(answer, answer, answer);
      const error = await provider(oauth.fetch)().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudflareConnectionError);
      expect((error as CloudflareConnectionError).problem).toBe("temporary");
      expect((error as CloudflareConnectionError).retryable).toBe(true);
      expect(oauth.refreshes).toHaveLength(3);
      expect(await readGrant(env.DB)).toMatchObject({
        status: "connected",
        problem: expect.stringContaining("did not answer"),
      });
      expect(await storedRefreshToken()).toBe(REFRESH);
      expect(await connectionNeedsReconnecting({ DB: env.DB, CF_GRANT_KEY: KEY_SECRET })).toBe(
        false,
      );
    },
  );

  it("a broken 200 is tried once more only: the token may already have rotated", async () => {
    await seedGrant({ access: null, accessExpiresAt: null });
    const { oauth } = world();
    oauth.next.push("malformed", "malformed", "malformed");
    const error = await provider(oauth.fetch)().catch((e: unknown) => e);
    expect((error as CloudflareConnectionError).problem).toBe("temporary");
    expect(oauth.refreshes).toHaveLength(2);
    expect(await readGrant(env.DB)).toMatchObject({ status: "connected" });
  });

  it("a temporary failure followed by an answer refreshes and clears the problem", async () => {
    await seedGrant({ access: null, accessExpiresAt: null });
    const { oauth } = world();
    oauth.next.push({ status: 502 });
    expect(await provider(oauth.fetch)()).toBe("cf-access-SECRET-1");
    expect(oauth.refreshes).toHaveLength(2);
    expect(await readGrant(env.DB)).toMatchObject({ status: "connected", problem: null });
  });

  it("another refusal (invalid_client) ends the call without marking the grant", async () => {
    await seedGrant({ access: null, accessExpiresAt: null });
    const { oauth } = world();
    oauth.next.push("invalid_client");
    const error = await provider(oauth.fetch)().catch((e: unknown) => e);
    expect((error as CloudflareConnectionError).problem).toBe("refused");
    expect((error as CloudflareConnectionError).retryable).toBe(false);
    expect(oauth.refreshes).toHaveLength(1);
    expect(await readGrant(env.DB)).toMatchObject({ status: "connected" });
  });
});

describe("the key the grant is sealed with", () => {
  it("a version without the key, right after it was written, is still redeploying (retryable)", async () => {
    const row = await seedGrant({ connectedAt: START - 60_000 });
    await writeSettings(createDb(env.DB), {
      [SETTING.cfGrantKey]: JSON.stringify({ id: row.keyId, writtenAt: START - 30_000 }),
    });
    const { oauth } = world();
    const error = await provider(oauth.fetch, { grantKey: null })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareConnectionError);
    expect((error as CloudflareConnectionError).problem).toBe("redeploying");
    expect((error as CloudflareConnectionError).retryable).toBe(true);
    expect(oauth.refreshes).toEqual([]);
    // Nothing is marked: the next version reads the grant.
    expect(await readGrant(env.DB)).toMatchObject({ status: "connected" });
    const view = await readConnectionState({ DB: env.DB }, { now });
    expect(view).toMatchObject({ kind: "oauth", state: "connected", ready: false });
  });

  it("an older key in the running version, while a newer one rolls out, is also redeploying", async () => {
    await seedGrant({ connectedAt: START - 60_000 });
    const { oauth } = world();
    const error = await provider(oauth.fetch, { grantKey: generateGrantKey() })().catch(
      (e: unknown) => e,
    );
    expect((error as CloudflareConnectionError).problem).toBe("redeploying");
  });

  it("a key missing long after it was written is lost: an administrator has to reconnect", async () => {
    await seedGrant({ connectedAt: START - KEY_REDEPLOY_WINDOW_MS - 1 });
    const { oauth } = world();
    const error = await provider(oauth.fetch, { grantKey: null })().catch((e: unknown) => e);
    expect((error as CloudflareConnectionError).problem).toBe("key_lost");
    expect((error as CloudflareConnectionError).retryable).toBe(false);
    const view = await readConnectionState({ DB: env.DB }, { now });
    expect(view).toMatchObject({ state: "needs_reconnect", ready: false });
    expect(view.problem).toContain("cannot read its saved connection");
  });
});

describe("secrets stay secret", () => {
  it("no token appears in a log line, an error, a setting or the stored grant", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });
    }
    await seedGrant({ access: null, accessExpiresAt: null });
    const { oauth } = world();
    const errors: string[] = [];
    // A refresh, a temporary failure, a refusal, and a needs-reconnect.
    await provider(oauth.fetch)();
    clock += 2 * 60 * 60_000;
    oauth.next.push({ status: 503 }, { status: 503 }, { status: 503 });
    await provider(oauth.fetch)().catch((e: unknown) => errors.push(String(e)));
    oauth.next.push("invalid_client");
    await provider(oauth.fetch)().catch((e: unknown) => errors.push(String(e)));
    oauth.next.push("invalid_grant");
    await provider(oauth.fetch)().catch((e: unknown) => errors.push(String(e)));

    const settings = await env.DB.prepare("SELECT key, value FROM settings").all();
    const grant = await env.DB.prepare("SELECT * FROM cloudflare_grant").all();
    const haystack = JSON.stringify({
      lines,
      errors,
      settings: settings.results,
      grant: grant.results,
    });
    for (const secret of [REFRESH, ACCESS, KEY_SECRET, ...oauth.issued]) {
      expect(haystack).not.toContain(secret);
    }
    expect(haystack).not.toContain("SECRET");
    expect(errors).toHaveLength(3);
  });
});
