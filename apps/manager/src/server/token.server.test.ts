import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import {
  active,
  type FakeRoute,
  FORBIDDEN,
  fakeCloudflare,
  INVALID_TOKEN,
} from "../test/fake-cloudflare";
import {
  rotateTokenStep,
  saveTokenStep,
  TOKEN_STEP_MESSAGES,
  TokenStepError,
} from "./token.server";

const TOKEN = "cfat_TEST-token-value-DO-NOT-LEAK";
const ACC = "acc0000000000000000000000000000a";
const A = `/accounts/${ACC}`;
const HOST = "appflare.appflare-dev.workers.dev";
const NOW = new Date("2026-09-22T12:00:00.000Z");

const ok = (result: unknown): FakeRoute => ({ result });

/** The running version (`CF_VERSION_METADATA.id`) and Cloudflare's answer for an unknown one. */
const VERSION = "5b1c3a9e-0d2f-4c7a-9e1b-2f3a4b5c6d7e";
const VERSION_NOT_FOUND: FakeRoute = {
  status: 404,
  errors: [
    {
      code: 100146,
      message:
        "The requested Worker version could not be found, please check the ID being passed and try again.",
    },
  ],
};

/** An account token for ACC whose account holds the manager `appflare`. */
function accountTokenRoutes(scripts: string[] = ["appflare", "cut"], subdomain = "appflare-dev") {
  return {
    "GET /user/tokens/verify": INVALID_TOKEN,
    "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
    [`GET ${A}/workers/subdomain`]: ok({ subdomain }),
    [`GET ${A}/tokens/verify`]: active(),
    [`GET ${A}/workers/scripts`]: ok(scripts.map((id) => ({ id }))),
    [`GET ${A}/storage/kv/namespaces`]: ok([]),
    [`GET ${A}/d1/database`]: ok([]),
    [`PUT ${A}/workers/scripts/appflare/secrets`]: ok({
      name: "CF_API_TOKEN",
      type: "secret_text",
    }),
    [`DELETE ${A}/workers/scripts/appflare/secrets/SETUP_TOKEN`]: ok(null),
  } satisfies Record<string, FakeRoute>;
}

const deps = (api: ReturnType<typeof fakeCloudflare>, host = HOST) => ({
  db: env.DB,
  token: TOKEN,
  host,
  fetch: api.fetch,
  onRequest: api.onRequest,
  now: () => NOW,
});

async function settingsNow() {
  return readSettings(createDb(env.DB), Object.values(SETTING));
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TokenStepError);
    const message = (error as Error).message;
    expect(message).not.toContain(TOKEN);
    return message;
  }
  throw new Error("expected the step to fail");
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("saveTokenStep", () => {
  it("stores the token on its own Worker, records settings, then deletes a leftover SETUP_TOKEN", async () => {
    const api = fakeCloudflare(accountTokenRoutes());
    const result = await saveTokenStep({ ...deps(api), setupTokenBound: true });
    expect(result).toEqual({
      ok: true,
      accountId: ACC,
      workerName: "appflare",
      setupTokenRemoved: true,
    });

    const put = api.calls.find((c) => c.key === `PUT ${A}/workers/scripts/appflare/secrets`);
    expect(JSON.parse(put?.body ?? "null")).toEqual({
      name: "CF_API_TOKEN",
      text: TOKEN,
      type: "secret_text",
    });
    const keys = api.keys();
    expect(keys.indexOf(`DELETE ${A}/workers/scripts/appflare/secrets/SETUP_TOKEN`)).toBe(
      keys.length - 1,
    );

    expect(await settingsNow()).toEqual({
      account_id: ACC,
      account_name: "Appflare Dev",
      worker_name: "appflare",
      cf_token_configured: "1",
      cf_token_verified_at: NOW.toISOString(),
    });
    // Logged as METHOD path -> status only.
    expect(JSON.stringify(api.logs)).not.toContain(TOKEN);
    expect(api.logs).toContainEqual({
      method: "PUT",
      path: `${A}/workers/scripts/appflare/secrets`,
      status: 200,
    });
  });

  it("treats an already-deleted SETUP_TOKEN as removed", async () => {
    const api = fakeCloudflare({
      ...accountTokenRoutes(),
      [`DELETE ${A}/workers/scripts/appflare/secrets/SETUP_TOKEN`]: {
        status: 404,
        errors: [{ code: 10056, message: "secret not found" }],
      },
    });
    expect((await saveTokenStep({ ...deps(api), setupTokenBound: true })).setupTokenRemoved).toBe(
      true,
    );
  });

  it("still succeeds when SETUP_TOKEN cannot be deleted, and says so", async () => {
    const api = fakeCloudflare({
      ...accountTokenRoutes(),
      [`DELETE ${A}/workers/scripts/appflare/secrets/SETUP_TOKEN`]: { status: 500 },
    });
    const result = await saveTokenStep({ ...deps(api), setupTokenBound: true });
    expect(result.setupTokenRemoved).toBe(false);
    expect((await settingsNow()).cf_token_configured).toBe("1");
  });

  it("makes no SETUP_TOKEN call when the Worker has none", async () => {
    const api = fakeCloudflare(accountTokenRoutes());
    expect((await saveTokenStep(deps(api))).setupTokenRemoved).toBe(true);
    expect(api.keys().some((k) => k.startsWith("DELETE"))).toBe(false);
  });

  it("finds its own Worker by the running version, even on a custom domain", async () => {
    const api = fakeCloudflare({
      ...accountTokenRoutes(["cut", "team-apps"]),
      [`GET ${A}/workers/scripts/cut/versions/${VERSION}`]: VERSION_NOT_FOUND,
      [`GET ${A}/workers/scripts/team-apps/versions/${VERSION}`]: ok({ id: VERSION }),
      [`PUT ${A}/workers/scripts/team-apps/secrets`]: ok({}),
    });
    const result = await saveTokenStep({
      ...deps(api, "apps.example.com"),
      runningVersionId: VERSION,
    });
    expect(result.workerName).toBe("team-apps");
    expect((await settingsNow()).worker_name).toBe("team-apps");
  });

  it("refuses a token whose account does not run this version, writing nothing", async () => {
    const api = fakeCloudflare({
      ...accountTokenRoutes(["appflare"]),
      [`GET ${A}/workers/scripts/appflare/versions/${VERSION}`]: VERSION_NOT_FOUND,
    });
    const message = await failureOf(saveTokenStep({ ...deps(api), runningVersionId: VERSION }));
    expect(message).toBe(
      'This token is for account Appflare Dev (acc0000000000000000000000000000a), but this Appflare does not run in that account (it runs in the account with workers.dev subdomain "appflare-dev"). Create the token in the account Appflare is installed in.',
    );
    expect(api.keys().some((k) => k.startsWith("PUT") || k.startsWith("DELETE"))).toBe(false);
    expect(await settingsNow()).toEqual({});
  });

  describe("before the owner exists", () => {
    const configured = () =>
      writeSettings(createDb(env.DB), {
        [SETTING.cfTokenConfigured]: "1",
        [SETTING.accountId]: ACC,
      });

    it("verifies a stored token again and does not rewrite it", async () => {
      await configured();
      const api = fakeCloudflare(accountTokenRoutes());
      const result = await saveTokenStep(deps(api), { beforeOwner: { currentToken: TOKEN } });
      expect(result.accountId).toBe(ACC);
      expect(api.keys()).not.toContain(`PUT ${A}/workers/scripts/appflare/secrets`);
      expect((await settingsNow()).cf_token_verified_at).toBe(NOW.toISOString());
    });

    it("replaces a stored token with a different one for the same account", async () => {
      await configured();
      const api = fakeCloudflare(accountTokenRoutes());
      await saveTokenStep(deps(api), { beforeOwner: { currentToken: "cfat_the-previous-one" } });
      expect(api.keys()).toContain(`PUT ${A}/workers/scripts/appflare/secrets`);
    });

    it("refuses a token for another account than the stored one", async () => {
      await writeSettings(createDb(env.DB), {
        [SETTING.cfTokenConfigured]: "1",
        [SETTING.accountId]: "acc0000000000000000000000000000b",
      });
      const api = fakeCloudflare(accountTokenRoutes());
      const message = await failureOf(
        saveTokenStep(deps(api), { beforeOwner: { currentToken: undefined } }),
      );
      expect(message).toBe(TOKEN_STEP_MESSAGES.otherAccountBeforeOwner);
      expect(api.keys().some((k) => k.startsWith("PUT"))).toBe(false);
    });
  });

  it("uses the workers.dev host label as the Worker name", async () => {
    const routes = accountTokenRoutes(["mgr", "appflare"]);
    const api = fakeCloudflare({
      ...routes,
      [`PUT ${A}/workers/scripts/mgr/secrets`]: ok({}),
      [`DELETE ${A}/workers/scripts/mgr/secrets/SETUP_TOKEN`]: ok(null),
    });
    const result = await saveTokenStep(deps(api, "mgr.appflare-dev.workers.dev"));
    expect(result.workerName).toBe("mgr");
    expect(api.keys()).not.toContain(`PUT ${A}/workers/scripts/appflare/secrets`);
  });

  it("fails before writing anything when its own Worker is not in the account", async () => {
    const api = fakeCloudflare(accountTokenRoutes(["cut"]));
    const message = await failureOf(saveTokenStep(deps(api, "mgr.appflare-dev.workers.dev")));
    expect(message).toContain("could not find its own Worker");
    expect(api.keys().some((k) => k.startsWith("PUT"))).toBe(false);
    expect(await settingsNow()).toEqual({});
  });

  it("never touches another account's `appflare` Worker", async () => {
    const api = fakeCloudflare(accountTokenRoutes(["appflare"], "someone-else"));
    const message = await failureOf(saveTokenStep(deps(api)));
    expect(message).toContain("this manager runs in the account with workers.dev subdomain");
    expect(api.keys().some((k) => k.startsWith("PUT") || k.startsWith("DELETE"))).toBe(false);
    expect(await settingsNow()).toEqual({});
  });

  it("fails when the token cannot list Workers scripts", async () => {
    const api = fakeCloudflare({
      ...accountTokenRoutes(),
      [`GET ${A}/workers/scripts`]: FORBIDDEN,
    });
    expect(await failureOf(saveTokenStep(deps(api)))).toBe(TOKEN_STEP_MESSAGES.needsScripts);
  });

  it("refuses once a token is configured", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.cfTokenConfigured]: "1" });
    const api = fakeCloudflare(accountTokenRoutes());
    expect(await failureOf(saveTokenStep(deps(api)))).toBe(TOKEN_STEP_MESSAGES.alreadyConfigured);
    expect(api.calls).toHaveLength(0);
  });
});

describe("rotateTokenStep", () => {
  it("replaces the secret on the recorded Worker and refreshes verified_at", async () => {
    await writeSettings(
      createDb(env.DB),
      {
        [SETTING.accountId]: ACC,
        [SETTING.accountName]: "Appflare Dev",
        [SETTING.workerName]: "appflare",
        [SETTING.cfTokenConfigured]: "1",
        [SETTING.cfTokenVerifiedAt]: "2026-01-01T00:00:00.000Z",
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const api = fakeCloudflare(accountTokenRoutes());
    const result = await rotateTokenStep(deps(api));
    expect(result).toEqual({ ok: true, accountId: ACC, workerName: "appflare" });
    expect(api.keys()).toContain(`PUT ${A}/workers/scripts/appflare/secrets`);
    // Rotation never touches SETUP_TOKEN, and verifies against the known account.
    expect(api.keys().some((k) => k.includes("SETUP_TOKEN"))).toBe(false);
    expect(api.keys()).not.toContain("GET /user/tokens/verify");
    expect((await settingsNow()).cf_token_verified_at).toBe(NOW.toISOString());
  });

  it("refuses before setup has stored a token", async () => {
    const api = fakeCloudflare(accountTokenRoutes());
    expect(await failureOf(rotateTokenStep(deps(api)))).toBe(TOKEN_STEP_MESSAGES.notConfigured);
    expect(api.calls).toHaveLength(0);
  });
});
