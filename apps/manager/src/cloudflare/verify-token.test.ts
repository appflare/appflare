import { describe, expect, it } from "vitest";
import {
  active,
  type FakeRoute,
  FORBIDDEN,
  fakeCloudflare,
  INVALID_TOKEN,
} from "../test/fake-cloudflare";
import { MESSAGES, verifyCloudflareToken } from "./verify-token";

const TOKEN = "cfat_TEST-token-value-DO-NOT-LEAK";
const ACC = "acc0000000000000000000000000000a";
const OTHER = "acc0000000000000000000000000000b";
const HOST = "appflare.appflare-dev.workers.dev";
const A = `/accounts/${ACC}`;

const ok = (result: unknown): FakeRoute => ({ result });

/** Every capability probe succeeds. */
const probesFor = (acc: string, subdomain = "appflare-dev") => ({
  [`GET /accounts/${acc}/workers/subdomain`]: ok({ subdomain }),
  [`GET /accounts/${acc}/workers/scripts`]: ok([{ id: "appflare" }]),
  [`GET /accounts/${acc}/storage/kv/namespaces`]: ok([]),
  [`GET /accounts/${acc}/d1/database`]: ok([]),
});

async function run(
  routes: Parameters<typeof fakeCloudflare>[0],
  opts: { knownAccountId?: string | null; host?: string; runningVersionId?: string } = {},
) {
  const api = fakeCloudflare(routes);
  const outcome = await verifyCloudflareToken({
    token: TOKEN,
    knownAccountId: opts.knownAccountId ?? null,
    host: opts.host ?? HOST,
    ...(opts.runningVersionId === undefined ? {} : { runningVersionId: opts.runningVersionId }),
    fetch: api.fetch,
    onRequest: api.onRequest,
  });
  // The token is sent as the bearer and nowhere else.
  for (const call of api.calls) {
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.key).not.toContain(TOKEN);
  }
  expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  expect(JSON.stringify(api.logs)).not.toContain(TOKEN);
  return { ...outcome, api };
}

describe("verifyCloudflareToken during setup", () => {
  it("maps an account token: user verify 1000, account from /accounts, account verify", async () => {
    const { result, scripts, api } = await run({
      "GET /user/tokens/verify": INVALID_TOKEN,
      "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
      [`GET ${A}/tokens/verify`]: active({ expires_on: "2027-01-01T00:00:00Z" }),
      ...probesFor(ACC),
    });
    expect(result).toEqual({
      ok: true,
      tokenType: "account",
      accountId: ACC,
      accountName: "Appflare Dev",
      expiresOn: "2027-01-01T00:00:00Z",
      permissionsOk: true,
      missing: [],
    });
    expect(scripts).toEqual([{ id: "appflare" }]);
    expect(api.logs).toContainEqual({ method: "GET", path: `${A}/tokens/verify`, status: 200 });
  });

  it("maps a user token scoped to one account without calling the account verify", async () => {
    const { result, api } = await run({
      "GET /user/tokens/verify": active(),
      "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
      ...probesFor(ACC),
    });
    expect(result).toMatchObject({ ok: true, tokenType: "user", accountId: ACC });
    expect(result.ok && result.expiresOn).toBeUndefined();
    expect(api.keys()).not.toContain(`GET ${A}/tokens/verify`);
  });

  it("reports failed optional probes as missing but keeps permissionsOk", async () => {
    const { result } = await run({
      "GET /user/tokens/verify": active(),
      "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
      ...probesFor(ACC),
      [`GET ${A}/storage/kv/namespaces`]: FORBIDDEN,
      [`GET ${A}/d1/database`]: FORBIDDEN,
    });
    expect(result).toMatchObject({
      ok: true,
      permissionsOk: true,
      missing: ["Workers KV Storage: Edit", "D1: Edit"],
    });
  });

  it("sets permissionsOk false when Workers scripts cannot be listed", async () => {
    const { result, scripts } = await run({
      "GET /user/tokens/verify": active(),
      "GET /accounts": ok([{ id: ACC }]),
      ...probesFor(ACC),
      [`GET ${A}/workers/scripts`]: FORBIDDEN,
    });
    expect(result).toMatchObject({
      ok: true,
      permissionsOk: false,
      missing: ["Workers Scripts: Edit"],
    });
    expect(scripts).toBeNull();
  });

  it("picks the account whose workers.dev subdomain matches the host", async () => {
    const { result } = await run({
      "GET /user/tokens/verify": active(),
      "GET /accounts": ok([
        { id: OTHER, name: "Personal" },
        { id: ACC, name: "Appflare Dev" },
      ]),
      [`GET /accounts/${OTHER}/workers/subdomain`]: ok({ subdomain: "someone" }),
      [`GET ${A}/workers/subdomain`]: ok({ subdomain: "appflare-dev" }),
      ...probesFor(ACC),
    });
    expect(result).toMatchObject({ ok: true, accountId: ACC, accountName: "Appflare Dev" });
  });

  it("rejects a token Cloudflare does not accept anywhere", async () => {
    const { result } = await run({
      "GET /user/tokens/verify": INVALID_TOKEN,
      "GET /accounts": INVALID_TOKEN,
    });
    expect(result).toEqual({ ok: false, error: MESSAGES.rejectedOrNoAccount });
  });

  it("rejects a user token that sees no account", async () => {
    const { result } = await run({
      "GET /user/tokens/verify": active(),
      "GET /accounts": ok([]),
    });
    expect(result).toEqual({ ok: false, error: MESSAGES.noAccount });
  });

  it("rejects an inactive token", async () => {
    const { result } = await run({
      "GET /user/tokens/verify": INVALID_TOKEN,
      "GET /accounts": ok([{ id: ACC }]),
      [`GET ${A}/workers/subdomain`]: ok({ subdomain: "appflare-dev" }),
      [`GET ${A}/tokens/verify`]: active({ status: "expired" }),
    });
    expect(result).toEqual({ ok: false, error: MESSAGES.inactive("expired") });
  });

  it("confirms a single account against the workers.dev subdomain", async () => {
    const { result, api } = await run({
      "GET /user/tokens/verify": INVALID_TOKEN,
      "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
      [`GET ${A}/tokens/verify`]: active(),
      ...probesFor(ACC),
    });
    expect(result).toMatchObject({ ok: true, accountId: ACC });
    expect(api.keys()).toContain(`GET ${A}/workers/subdomain`);
  });

  it("rejects a single account whose workers.dev subdomain is not the host's", async () => {
    const { result, api } = await run({
      "GET /user/tokens/verify": INVALID_TOKEN,
      "GET /accounts": ok([{ id: OTHER, name: "Personal" }]),
      [`GET /accounts/${OTHER}/tokens/verify`]: active(),
      ...probesFor(OTHER, "someone-else"),
    });
    expect(result).toEqual({
      ok: false,
      error: MESSAGES.wrongAccount(`Personal (${OTHER})`, "appflare-dev"),
    });
    // Nothing past the account check runs.
    expect(api.keys()).not.toContain(`GET /accounts/${OTHER}/workers/scripts`);
  });

  it("rejects a single account whose subdomain cannot be read", async () => {
    const { result } = await run({
      "GET /user/tokens/verify": INVALID_TOKEN,
      "GET /accounts": ok([{ id: ACC }]),
      [`GET ${A}/workers/subdomain`]: FORBIDDEN,
    });
    expect(result).toEqual({ ok: false, error: MESSAGES.subdomainUnreadable(ACC) });
  });

  it("rejects several accounts when none has the host's subdomain", async () => {
    const { result } = await run({
      "GET /user/tokens/verify": active(),
      "GET /accounts": ok([{ id: OTHER }, { id: ACC }]),
      [`GET /accounts/${OTHER}/workers/subdomain`]: ok({ subdomain: "a" }),
      [`GET ${A}/workers/subdomain`]: ok({ subdomain: "b" }),
    });
    expect(result).toEqual({
      ok: false,
      error: MESSAGES.noAccountWithSubdomain(2, "appflare-dev"),
    });
  });

  it("fails closed off workers.dev without the running version, for any token, before any call", async () => {
    // Even a single-account account token that would verify is refused: nothing
    // ties its account to this manager.
    for (const userVerify of [active(), INVALID_TOKEN]) {
      const { result, api } = await run(
        {
          "GET /user/tokens/verify": userVerify,
          "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
          [`GET ${A}/tokens/verify`]: active(),
          ...probesFor(ACC),
        },
        { host: "apps.example.com" },
      );
      expect(result).toEqual({ ok: false, error: MESSAGES.cannotVerifyAccount });
      expect(api.calls).toHaveLength(0);
    }
  });

  it("follows /accounts pagination", async () => {
    const { result, api } = await run({
      "GET /user/tokens/verify": active(),
      "GET /accounts": (url) =>
        url.searchParams.get("page") === "2"
          ? { result: [{ id: ACC, name: "Appflare Dev" }], result_info: { total_pages: 2 } }
          : { result: [{ id: OTHER, name: "Personal" }], result_info: { total_pages: 2 } },
      [`GET /accounts/${OTHER}/workers/subdomain`]: ok({ subdomain: "someone" }),
      ...probesFor(ACC),
    });
    expect(result).toMatchObject({ ok: true, accountId: ACC, accountName: "Appflare Dev" });
    expect(api.keys().filter((k) => k === "GET /accounts")).toHaveLength(2);
  });

  it("reports an unreachable API without details", async () => {
    const { result } = await run({
      "GET /user/tokens/verify": "network-error",
      "GET /accounts": "network-error",
    });
    expect(result).toEqual({ ok: false, error: MESSAGES.unreachable });
  });
});

describe("verifyCloudflareToken during rotation", () => {
  it("verifies an account token against the known account first", async () => {
    const { result, api } = await run(
      {
        [`GET ${A}/tokens/verify`]: active(),
        "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
        ...probesFor(ACC),
      },
      { knownAccountId: ACC },
    );
    expect(result).toMatchObject({ ok: true, tokenType: "account", accountId: ACC });
    expect(api.keys()).not.toContain("GET /user/tokens/verify");
  });

  it("accepts a user token with access to the known account", async () => {
    const { result } = await run(
      {
        [`GET ${A}/tokens/verify`]: INVALID_TOKEN,
        "GET /user/tokens/verify": active(),
        "GET /accounts": ok([{ id: OTHER }, { id: ACC, name: "Appflare Dev" }]),
        ...probesFor(ACC),
      },
      { knownAccountId: ACC },
    );
    expect(result).toMatchObject({ ok: true, tokenType: "user", accountName: "Appflare Dev" });
  });

  it("rejects a user token without access to the known account", async () => {
    const { result } = await run(
      {
        [`GET ${A}/tokens/verify`]: INVALID_TOKEN,
        "GET /user/tokens/verify": active(),
        "GET /accounts": ok([{ id: OTHER }]),
      },
      { knownAccountId: ACC },
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.otherAccount });
  });

  it("rejects an account token for another account", async () => {
    const { result } = await run(
      {
        [`GET ${A}/tokens/verify`]: INVALID_TOKEN,
        "GET /user/tokens/verify": INVALID_TOKEN,
      },
      { knownAccountId: ACC },
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.otherAccount });
  });

  it("warns when the account name cannot be read", async () => {
    const { result } = await run(
      {
        [`GET ${A}/tokens/verify`]: active(),
        "GET /accounts": FORBIDDEN,
        ...probesFor(ACC),
      },
      { knownAccountId: ACC },
    );
    expect(result).toMatchObject({ ok: true, missing: ["Account Settings: Read"] });
    expect(result.ok && result.accountName).toBeUndefined();
  });
});

describe("verifyCloudflareToken during setup, by the running version", () => {
  const VERSION = "5b1c3a9e-0d2f-4c7a-9e1b-2f3a4b5c6d7e";
  const NOT_FOUND: FakeRoute = {
    status: 404,
    errors: [{ code: 100146, message: "The requested Worker version could not be found" }],
  };
  const version = (acc: string, script: string, found: boolean) => ({
    [`GET /accounts/${acc}/workers/scripts/${script}/versions/${VERSION}`]: found
      ? ok({ id: VERSION })
      : NOT_FOUND,
  });

  it("picks the account holding the running version for a user token that sees several", async () => {
    const { result, workerName, api } = await run(
      {
        "GET /user/tokens/verify": active(),
        "GET /accounts": ok([
          { id: OTHER, name: "Personal" },
          { id: ACC, name: "Appflare Dev" },
        ]),
        ...probesFor(ACC),
        // Both accounts have an `appflare` Worker; only one runs this version.
        [`GET /accounts/${OTHER}/workers/scripts`]: ok([{ id: "appflare" }]),
        ...version(OTHER, "appflare", false),
        ...version(ACC, "appflare", true),
      },
      { runningVersionId: VERSION },
    );
    expect(result).toMatchObject({ ok: true, tokenType: "user", accountId: ACC });
    expect(workerName).toBe("appflare");
    // No workers.dev subdomain comparison is needed.
    expect(api.keys().some((k) => k.endsWith("/workers/subdomain"))).toBe(false);
  });

  it("accepts a user token on a custom domain and finds a renamed manager", async () => {
    const { result, workerName } = await run(
      {
        "GET /user/tokens/verify": active(),
        "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
        ...probesFor(ACC),
        [`GET ${A}/workers/scripts`]: ok([{ id: "cut" }, { id: "team-apps" }]),
        ...version(ACC, "cut", false),
        ...version(ACC, "team-apps", true),
      },
      { host: "apps.example.com", runningVersionId: VERSION },
    );
    expect(result).toMatchObject({ ok: true, tokenType: "user", accountId: ACC });
    expect(workerName).toBe("team-apps");
  });

  it("refuses an account token from another account with a plain message", async () => {
    const { result, workerName } = await run(
      {
        "GET /user/tokens/verify": INVALID_TOKEN,
        "GET /accounts": ok([{ id: OTHER, name: "Personal" }]),
        [`GET /accounts/${OTHER}/workers/scripts`]: ok([{ id: "appflare" }]),
        ...version(OTHER, "appflare", false),
      },
      { runningVersionId: VERSION },
    );
    expect(result).toEqual({
      ok: false,
      error: MESSAGES.notThisAccount(`Personal (${OTHER})`, "appflare-dev"),
    });
    expect(workerName).toBeNull();
  });

  it("says so when none of several accounts runs this Appflare", async () => {
    const { result } = await run(
      {
        "GET /user/tokens/verify": active(),
        "GET /accounts": ok([{ id: OTHER }, { id: ACC }]),
        [`GET /accounts/${OTHER}/workers/scripts`]: ok([]),
        [`GET ${A}/workers/scripts`]: ok([{ id: "appflare" }]),
        ...version(ACC, "appflare", false),
      },
      { host: "apps.example.com", runningVersionId: VERSION },
    );
    expect(result).toEqual({ ok: false, error: MESSAGES.noAccountRunsThis(2) });
  });

  it("asks for Workers Scripts when the account's Workers cannot be listed", async () => {
    const { result } = await run(
      {
        "GET /user/tokens/verify": INVALID_TOKEN,
        "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
        [`GET ${A}/workers/scripts`]: FORBIDDEN,
      },
      { runningVersionId: VERSION },
    );
    expect(result).toEqual({
      ok: false,
      error: MESSAGES.workersUnreadable(`Appflare Dev (${ACC})`),
    });
  });
});
