import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MANAGER_OAUTH_SCOPES } from "@appflare/cf-api/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { rotateTokenStep } from "../server/token.server";
import { ACC } from "../test/fake-account";
import { type FakeRoute, fakeCloudflare } from "../test/fake-cloudflare";
import { fakeOAuth } from "../test/fake-oauth";
import {
  cloudflareCredential,
  createConnectionMemo,
  readConnectionState,
} from "./connection.server";
import type { CloudflareConnectionError } from "./connection-errors";
import { GRANT_STORE_MESSAGES, GrantStoreError, storeGrant } from "./grant.server";
import { GRANT_KEY_SECRET, generateGrantKey, grantKeyId } from "./grant-seal";
import { readGrant } from "./grant-store.server";

/**
 * Storing a grant as the manager's connection (the handoff and an OAuth
 * reconnect use it) and giving it up for an API token.
 */

const A = `/accounts/${ACC}`;
const START = 1_790_000_000_000;
const CLIENT = "b99863433175d812f9595af56dd1b71d";
const HANDED = "cf-refresh-SECRET-handed-over";
const VERSION = "11111111-2222-4333-8444-555555555555";
const HOST = "appflare.appflare-dev.workers.dev";
const API_TOKEN = "cf-api-token-SECRET-new";

const ok = (result: unknown): FakeRoute => ({ result });

function routes(over: Record<string, FakeRoute> = {}): Record<string, FakeRoute> {
  return {
    "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
    [`GET ${A}/workers/scripts`]: ok([{ id: "appflare" }, { id: "cut" }]),
    [`GET ${A}/workers/scripts/appflare/versions/${VERSION}`]: ok({ id: VERSION }),
    [`PUT ${A}/workers/scripts/appflare/secrets`]: ok({ name: "x", type: "secret_text" }),
    ...over,
  };
}

function world(over: Record<string, FakeRoute> = {}, scopes?: readonly string[]) {
  const api = fakeCloudflare(routes(over));
  const oauth = fakeOAuth(api.fetch, scopes === undefined ? {} : { scopes });
  return { api, oauth };
}

let generated: string[] = [];

function deps(w: ReturnType<typeof world>, over: Partial<Parameters<typeof storeGrant>[0]> = {}) {
  return {
    db: env.DB,
    grant: { refreshToken: HANDED, clientId: CLIENT, scopes: MANAGER_OAUTH_SCOPES },
    accountId: ACC,
    host: HOST,
    runningVersionId: VERSION,
    fetch: w.oauth.fetch,
    now: () => START,
    sleep: async () => {},
    memo: createConnectionMemo(),
    generateKey: () => {
      const key = generateGrantKey();
      generated.push(key);
      return key;
    },
    ...over,
  };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  generated = [];
});

afterEach(() => vi.restoreAllMocks());

describe("storeGrant", () => {
  it("takes over rotation, checks the account, writes the key once and stores the grant sealed", async () => {
    const w = world();
    const memo = createConnectionMemo();
    const stored = await storeGrant(deps(w, { memo }));
    expect(stored).toEqual({
      accountId: ACC,
      accountName: "Appflare Dev",
      workerName: "appflare",
      scopes: [...MANAGER_OAUTH_SCOPES],
      keyWritten: true,
      previous: null,
    });
    // Refreshed at once with what was handed over.
    expect(w.oauth.refreshes).toEqual([{ clientId: CLIENT, refreshToken: HANDED }]);
    // The key went to the Worker as its own secret, with the new access token.
    const put = w.api.calls.find((c) => c.key === `PUT ${A}/workers/scripts/appflare/secrets`);
    expect(JSON.parse(put?.body ?? "null")).toEqual({
      name: GRANT_KEY_SECRET,
      type: "secret_text",
      text: generated[0],
    });
    expect(put?.authorization).toBe("Bearer cf-access-SECRET-1");
    const row = await readGrant(env.DB);
    expect(row).toMatchObject({
      clientId: CLIENT,
      status: "connected",
      keyId: await grantKeyId(generated[0] ?? ""),
    });
    expect(JSON.stringify(row)).not.toContain("SECRET");
    const settings = await readSettings(createDb(env.DB), [
      SETTING.accountId,
      SETTING.workerName,
      SETTING.cfTokenConfigured,
      SETTING.cfGrantKey,
    ]);
    expect(settings).toMatchObject({
      account_id: ACC,
      worker_name: "appflare",
      cf_token_configured: "1",
    });
    // This isolate holds the key: it serves at once, before the redeploy.
    const token = cloudflareCredential(
      { DB: env.DB },
      { memo, fetch: w.oauth.fetch, now: () => START },
    );
    expect(await token()).toBe("cf-access-SECRET-1");
    // Another isolate of the old version (no key) is told to wait.
    const other = cloudflareCredential(
      { DB: env.DB },
      { memo: createConnectionMemo(), fetch: w.oauth.fetch, now: () => START },
    );
    const error = await other().catch((e: unknown) => e);
    expect((error as CloudflareConnectionError).problem).toBe("redeploying");
    // The new version, which has the key, reads the stored access token.
    const next = cloudflareCredential(
      { DB: env.DB, CF_GRANT_KEY: generated[0] },
      { memo: createConnectionMemo(), fetch: w.oauth.fetch, now: () => START },
    );
    expect(await next()).toBe("cf-access-SECRET-1");
    expect(w.oauth.refreshes).toHaveLength(1);
    const view = await readConnectionState({ DB: env.DB, CF_GRANT_KEY: generated[0] });
    expect(view).toMatchObject({ kind: "oauth", state: "connected", ready: true });
    expect(view.oauth).toMatchObject({ clientId: CLIENT, missingScopes: [] });
  });

  it("uses the key the Worker already has, without writing it again", async () => {
    const key = generateGrantKey();
    await writeSettings(createDb(env.DB), {
      [SETTING.cfGrantKey]: JSON.stringify({ id: await grantKeyId(key), writtenAt: START - 1 }),
    });
    const w = world();
    const stored = await storeGrant(deps(w, { grantKey: key }));
    expect(stored.keyWritten).toBe(false);
    expect(w.api.keys()).not.toContain(`PUT ${A}/workers/scripts/appflare/secrets`);
    expect((await readGrant(env.DB))?.keyId).toBe(await grantKeyId(key));
  });

  it("refuses an account this Worker does not run in, and revokes the grant it just rotated", async () => {
    const w = world({ [`GET ${A}/workers/scripts/appflare/versions/${VERSION}`]: { status: 404 } });
    const error = await storeGrant(deps(w)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrantStoreError);
    expect((error as Error).message).toContain("does not run in that account");
    expect(w.oauth.revokes).toEqual([{ clientId: CLIENT, refreshToken: "cf-refresh-SECRET-1" }]);
    expect(await readGrant(env.DB)).toBeNull();
    expect(w.api.keys()).not.toContain(`PUT ${A}/workers/scripts/appflare/secrets`);
  });

  it("refuses a grant without every scope the manager asks for", async () => {
    const w = world({}, MANAGER_OAUTH_SCOPES.slice(1));
    const error = await storeGrant(deps(w)).catch((e: unknown) => e);
    expect((error as Error).message).toBe(GRANT_STORE_MESSAGES.missingScopes);
    expect(w.oauth.revokes).toHaveLength(1);
    expect(await readGrant(env.DB)).toBeNull();
  });

  it("refuses a grant Cloudflare no longer accepts, in plain words", async () => {
    const w = world();
    w.oauth.next.push("invalid_grant");
    const error = await storeGrant(deps(w)).catch((e: unknown) => e);
    expect((error as Error).message).toBe(GRANT_STORE_MESSAGES.refused);
    expect(await readGrant(env.DB)).toBeNull();
  });

  it("refuses another account than the recorded one", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.accountId]: "acc-other" });
    const w = world();
    const error = await storeGrant(deps(w)).catch((e: unknown) => e);
    expect((error as Error).message).toBe(GRANT_STORE_MESSAGES.otherAccount);
    expect(w.oauth.refreshes).toEqual([]);
  });

  it("a new grant brings a connection that needed reconnecting back, and revokes the old one", async () => {
    const w = world();
    const key = generateGrantKey();
    await writeSettings(createDb(env.DB), {
      [SETTING.cfGrantKey]: JSON.stringify({ id: await grantKeyId(key), writtenAt: START - 1 }),
    });
    await storeGrant(deps(w, { grantKey: key }));
    // Cloudflare refuses it later: the connection needs reconnecting.
    const memo = createConnectionMemo();
    w.oauth.next.push("invalid_grant");
    const later = () => START + 2 * 60 * 60_000;
    const stale = cloudflareCredential(
      { DB: env.DB, CF_GRANT_KEY: key },
      { memo, fetch: w.oauth.fetch, now: later },
    );
    expect(((await stale().catch((e: unknown) => e)) as CloudflareConnectionError).problem).toBe(
      "needs_reconnect",
    );
    // An administrator connects again.
    await storeGrant(
      deps(w, {
        grantKey: key,
        grant: { refreshToken: "cf-refresh-SECRET-again", clientId: CLIENT, scopes: [] },
        now: later,
      }),
    );
    expect(w.oauth.revokes.map((r) => r.refreshToken)).toEqual(["cf-refresh-SECRET-1"]);
    const fresh = cloudflareCredential(
      { DB: env.DB, CF_GRANT_KEY: key },
      { memo: createConnectionMemo(), fetch: w.oauth.fetch, now: later },
    );
    // The second store's own refresh issued the next access token.
    expect(await fresh()).toBe("cf-access-SECRET-2");
    expect((await readGrant(env.DB))?.status).toBe("connected");
  });
});

describe("switching to an API token", () => {
  it("rotating the token on an OAuth connection deletes the grant and revokes it", async () => {
    const key = generateGrantKey();
    await writeSettings(createDb(env.DB), {
      [SETTING.cfGrantKey]: JSON.stringify({ id: await grantKeyId(key), writtenAt: START - 1 }),
    });
    const w = world({
      [`GET ${A}/tokens/verify`]: ok({ id: "t", status: "active" }),
      [`GET ${A}/workers/subdomain`]: ok({ subdomain: "appflare-dev" }),
    });
    await storeGrant(deps(w, { grantKey: key }));
    const rotated = await rotateTokenStep({
      db: env.DB,
      token: API_TOKEN,
      host: HOST,
      grantKey: key,
      fetch: w.oauth.fetch,
    });
    expect(rotated.replacedAuthorization).toBe(true);
    const puts = w.api.calls.filter((c) => c.key === `PUT ${A}/workers/scripts/appflare/secrets`);
    expect(JSON.parse(puts.at(-1)?.body ?? "null")).toMatchObject({ name: "CF_API_TOKEN" });
    expect(await readGrant(env.DB)).toBeNull();
    expect(w.oauth.revokes).toEqual([{ clientId: CLIENT, refreshToken: "cf-refresh-SECRET-1" }]);
    const view = await readConnectionState({ DB: env.DB, CF_API_TOKEN: API_TOKEN });
    expect(view.kind).toBe("api_token");
    // The connection is the API token from now on.
    const token = cloudflareCredential(
      { DB: env.DB, CF_API_TOKEN: API_TOKEN, CF_GRANT_KEY: key },
      { memo: createConnectionMemo() },
    );
    expect(await token()).toBe(API_TOKEN);
  });
});
