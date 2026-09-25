import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { active, type FakeRoute, fakeCloudflare, INVALID_TOKEN } from "../test/fake-cloudflare";
import {
  connectCloudflareStep,
  createOwnerStep,
  type OwnerInput,
  SETUP_CLAIM_TTL_MS,
  SETUP_MESSAGES,
  SETUP_RATE_LIMIT,
  setupClaimMatches,
  takeSetupAttempt,
} from "./setup.server";

const TOKEN = "cfat_TEST-token-value-DO-NOT-LEAK";
const ACC = "acc0000000000000000000000000000a";
const OTHER = "acc0000000000000000000000000000b";
const A = `/accounts/${ACC}`;
const HOST = "appflare.appflare-dev.workers.dev";
const VERSION = "5b1c3a9e-0d2f-4c7a-9e1b-2f3a4b5c6d7e";
const NOW = new Date("2026-09-24T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

const ok = (result: unknown): FakeRoute => ({ result });
const NOT_FOUND: FakeRoute = {
  status: 404,
  errors: [{ code: 100146, message: "The requested Worker version could not be found" }],
};

/** An account token for `account`, whose `appflare` Worker runs VERSION when `runs`. */
function accountToken(account: string, runs: boolean): Record<string, FakeRoute> {
  const a = `/accounts/${account}`;
  return {
    "GET /user/tokens/verify": INVALID_TOKEN,
    "GET /accounts": ok([{ id: account, name: "Team" }]),
    [`GET ${a}/tokens/verify`]: active(),
    [`GET ${a}/workers/scripts`]: ok([{ id: "appflare" }]),
    [`GET ${a}/workers/scripts/appflare/versions/${VERSION}`]: runs
      ? ok({ id: VERSION })
      : NOT_FOUND,
    [`GET ${a}/storage/kv/namespaces`]: ok([]),
    [`GET ${a}/d1/database`]: ok([]),
    [`PUT ${a}/workers/scripts/appflare/secrets`]: ok({ name: "CF_API_TOKEN" }),
  };
}

function setupDeps(
  api: ReturnType<typeof fakeCloudflare>,
  opts: { client?: string; now?: Date } = {},
) {
  return {
    token: {
      db: env.DB,
      token: TOKEN,
      host: HOST,
      runningVersionId: VERSION,
      fetch: api.fetch,
      onRequest: api.onRequest,
      now: () => opts.now ?? NOW,
    },
    client: opts.client ?? "203.0.113.7",
    now: opts.now ?? NOW,
  };
}

async function connect(
  api: ReturnType<typeof fakeCloudflare>,
  opts: {
    claimCookie?: string;
    now?: Date;
    client?: string;
    authSecretBound?: boolean;
    selfBound?: boolean;
    generateAuthSecret?: () => string;
  } = {},
) {
  return connectCloudflareStep({
    ...setupDeps(api, opts),
    claimCookie: opts.claimCookie,
    currentToken: undefined,
    // A manager the installer deployed has both.
    authSecretBound: opts.authSecretBound ?? true,
    selfBound: opts.selfBound ?? true,
    ...(opts.generateAuthSecret ? { generateAuthSecret: opts.generateAuthSecret } : {}),
  });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const message = (error as Error).message;
    expect(message).not.toContain(TOKEN);
    return message;
  }
  throw new Error("expected a refusal");
}

let users = 0;
const OWNER: OwnerInput = { email: "ada@example.com", name: "Ada", password: "a-long-password" };

/** Stands in for Better Auth's admin `createUser`. */
async function createUser(input: OwnerInput) {
  const id = `u${++users}`;
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at, role)
     VALUES (?1, ?2, ?3, 0, ?4, ?4, 'admin')`,
  )
    .bind(id, input.name, input.email, NOW.getTime())
    .run();
  return { id };
}

async function ownerFlags() {
  const { results } = await env.DB.prepare("SELECT id, is_owner FROM user ORDER BY id").all<{
    id: string;
    is_owner: number | null;
  }>();
  return results;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  users = 0;
});

describe("the rate limit on the token step", () => {
  it("allows the limit per client in ten minutes, then refuses until the window ends", async () => {
    for (let i = 0; i < SETUP_RATE_LIMIT.max; i++) {
      expect(await takeSetupAttempt(env.DB, "203.0.113.7", later(i * 1000))).toBe(true);
    }
    expect(await takeSetupAttempt(env.DB, "203.0.113.7", later(60_000))).toBe(false);
    // Another client has its own count.
    expect(await takeSetupAttempt(env.DB, "198.51.100.2", later(60_000))).toBe(true);
    // A new window starts ten minutes after the first attempt.
    expect(await takeSetupAttempt(env.DB, "203.0.113.7", later(SETUP_RATE_LIMIT.windowMs))).toBe(
      true,
    );
  });

  it("stores no client address", async () => {
    await takeSetupAttempt(env.DB, "203.0.113.7", NOW);
    const { results } = await env.DB.prepare("SELECT id, key FROM rate_limit").all();
    expect(JSON.stringify(results)).not.toContain("203.0.113.7");
  });

  it("refuses the token step once the limit is used up, before calling Cloudflare", async () => {
    for (let i = 0; i < SETUP_RATE_LIMIT.max; i++) {
      await takeSetupAttempt(env.DB, "203.0.113.7", NOW);
    }
    const api = fakeCloudflare(accountToken(ACC, true));
    expect(await refusal(connect(api))).toBe(SETUP_MESSAGES.rateLimited);
    expect(api.calls).toHaveLength(0);
  });

  it("counts one attempt per connect: verifying and saving are one call", async () => {
    await connect(fakeCloudflare(accountToken(ACC, true)));
    const { results } = await env.DB.prepare("SELECT count FROM rate_limit").all<{
      count: number;
    }>();
    expect(results).toEqual([{ count: 1 }]);
  });
});

describe("connecting Cloudflare before any user exists", () => {
  it("verifies and stores the token in one call, naming the account", async () => {
    const api = fakeCloudflare(accountToken(ACC, true));
    const connected = await connect(api);
    expect(connected).toMatchObject({
      ok: true,
      accountId: ACC,
      accountName: "Team",
      workerName: "appflare",
      missing: [],
    });
    // Verified first (the token and the running version), then stored.
    const keys = api.keys();
    expect(keys.indexOf(`GET ${A}/workers/scripts/appflare/versions/${VERSION}`)).toBeLessThan(
      keys.indexOf(`PUT ${A}/workers/scripts/appflare/secrets`),
    );
  });

  it("names what the token could not confirm, and still saves", async () => {
    const api = fakeCloudflare({
      ...accountToken(ACC, true),
      [`GET ${A}/d1/database`]: { status: 403, errors: [{ code: 10000, message: "denied" }] },
    });
    const connected = await connect(api);
    expect(connected.missing).toEqual(["D1: Edit"]);
    expect(api.keys()).toContain(`PUT ${A}/workers/scripts/appflare/secrets`);
  });

  it("stores the token and gives this browser the claim", async () => {
    const api = fakeCloudflare(accountToken(ACC, true));
    const connected = await connect(api);
    expect(connected).toMatchObject({ ok: true, accountId: ACC, workerName: "appflare" });
    expect(api.keys()).toContain(`PUT ${A}/workers/scripts/appflare/secrets`);
    expect(await setupClaimMatches(env.DB, connected.claim.value, NOW)).toBe(true);
    expect(await setupClaimMatches(env.DB, "someone-else", NOW)).toBe(false);
    expect(await setupClaimMatches(env.DB, connected.claim.value, later(SETUP_CLAIM_TTL_MS))).toBe(
      false,
    );
    // Only the claim's hash is stored.
    const row = await readSettings(createDb(env.DB), [SETTING.setupClaim]);
    expect(row.setup_claim).not.toContain(connected.claim.value);
  });

  it("refuses a token for another account, writing nothing", async () => {
    const api = fakeCloudflare(accountToken(OTHER, false));
    const message = await refusal(connect(api));
    expect(message).toContain("this Appflare does not run in that account");
    expect(api.keys().some((k) => k.startsWith("PUT"))).toBe(false);
    expect(await readSettings(createDb(env.DB), Object.values(SETTING))).toEqual({});
  });

  it("refuses a second browser while the first one's claim holds, and lets it in after", async () => {
    await connect(fakeCloudflare(accountToken(ACC, true)));
    const second = fakeCloudflare(accountToken(ACC, true));
    expect(await refusal(connect(second, { client: "198.51.100.2" }))).toBe(
      SETUP_MESSAGES.inProgress(30),
    );
    expect(second.calls).toHaveLength(0);
    // Once the claim has expired, a valid token for this account wins again.
    const after = await connect(second, {
      client: "198.51.100.2",
      now: later(SETUP_CLAIM_TTL_MS + 1),
    });
    expect(after.claim.value.length).toBeGreaterThan(20);
  });

  it("lets the browser holding the claim paste the token again", async () => {
    const first = await connect(fakeCloudflare(accountToken(ACC, true)));
    const again = await connect(fakeCloudflare(accountToken(ACC, true)), {
      claimCookie: first.claim.value,
    });
    expect(await setupClaimMatches(env.DB, first.claim.value, NOW)).toBe(false);
    expect(await setupClaimMatches(env.DB, again.claim.value, NOW)).toBe(true);
  });

  it("treats a tampered claim cookie as no claim", async () => {
    const { claim } = await connect(fakeCloudflare(accountToken(ACC, true)));
    const last = claim.value.at(-1) === "A" ? "B" : "A";
    const tampered = `${claim.value.slice(0, -1)}${last}`;
    expect(await setupClaimMatches(env.DB, tampered, NOW)).toBe(false);
    expect(await setupClaimMatches(env.DB, `${claim.value}x`, NOW)).toBe(false);
    // It cannot take over the step either.
    const other = fakeCloudflare(accountToken(ACC, true));
    expect(await refusal(connect(other, { claimCookie: tampered }))).toBe(
      SETUP_MESSAGES.inProgress(30),
    );
    expect(
      await refusal(
        createOwnerStep({
          d1: env.DB,
          claimCookie: tampered,
          now: NOW,
          authReady: true,
          input: OWNER,
          createUser,
        }),
      ),
    ).toBe(SETUP_MESSAGES.connectFirst);
    expect(await ownerFlags()).toEqual([]);
  });

  it("lets exactly one of two browsers connecting at once win the claim", async () => {
    const results = await Promise.allSettled([
      connect(fakeCloudflare(accountToken(ACC, true)), { client: "203.0.113.7" }),
      connect(fakeCloudflare(accountToken(ACC, true)), { client: "198.51.100.2" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect([SETUP_MESSAGES.busy, SETUP_MESSAGES.inProgress(30)]).toContain(
      (lost[0]?.reason as Error | undefined)?.message,
    );
    const winner = won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof connect>>>;
    expect(await setupClaimMatches(env.DB, winner.value.claim.value, NOW)).toBe(true);
  });

  it("refuses once a user exists", async () => {
    await createUser(OWNER);
    const api = fakeCloudflare(accountToken(ACC, true));
    expect(await refusal(connect(api))).toBe(SETUP_MESSAGES.alreadyDone);
    expect(api.calls).toHaveLength(0);
  });
});

describe("creating the owner", () => {
  it("needs the claim from connecting Cloudflare", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.cfTokenConfigured]: "1" });
    for (const claimCookie of [undefined, "forged"]) {
      const message = await refusal(
        createOwnerStep({
          d1: env.DB,
          claimCookie,
          now: NOW,
          authReady: true,
          input: OWNER,
          createUser,
        }),
      );
      expect(message).toBe(SETUP_MESSAGES.connectFirst);
    }
    expect(await ownerFlags()).toEqual([]);
  });

  it("creates the owner with a valid claim, then retires the claim", async () => {
    const { claim } = await connect(fakeCloudflare(accountToken(ACC, true)));
    await createOwnerStep({
      d1: env.DB,
      claimCookie: claim.value,
      now: NOW,
      authReady: true,
      input: OWNER,
      createUser,
    });
    expect(await ownerFlags()).toEqual([{ id: "u1", is_owner: 1 }]);
    expect(await readSettings(createDb(env.DB), [SETTING.setupClaim])).toEqual({});
    // A second attempt (another tab, a replay) is told to sign in.
    const message = await refusal(
      createOwnerStep({
        d1: env.DB,
        claimCookie: claim.value,
        now: NOW,
        authReady: true,
        input: OWNER,
        createUser,
      }),
    );
    expect(message).toBe(SETUP_MESSAGES.alreadyDone);
    expect(await ownerFlags()).toHaveLength(1);
  });

  it("refuses an expired claim", async () => {
    const { claim } = await connect(fakeCloudflare(accountToken(ACC, true)));
    const message = await refusal(
      createOwnerStep({
        d1: env.DB,
        claimCookie: claim.value,
        now: later(SETUP_CLAIM_TTL_MS),
        authReady: true,
        input: OWNER,
        createUser,
      }),
    );
    expect(message).toBe(SETUP_MESSAGES.connectFirst);
  });

  it("waits until a version with the auth secret serves", async () => {
    const { claim } = await connect(fakeCloudflare(accountToken(ACC, true)), {
      authSecretBound: false,
    });
    const message = await refusal(
      createOwnerStep({
        d1: env.DB,
        claimCookie: claim.value,
        now: NOW,
        authReady: false,
        input: OWNER,
        createUser,
      }),
    );
    expect(message).toBe(SETUP_MESSAGES.redeploying);
    expect(await ownerFlags()).toEqual([]);
    // The claim still holds, so the same browser continues once it is live.
    expect(await setupClaimMatches(env.DB, claim.value, NOW)).toBe(true);
  });
});

describe("a manager deployed without secrets or SELF (the Deploy to Cloudflare button)", () => {
  const SELF_PATCH = `PATCH ${A}/workers/workers/appflare/versions/latest`;
  const DEPLOY = `POST ${A}/workers/scripts/appflare/deployments`;
  const withPatch = () => ({
    ...accountToken(ACC, true),
    [SELF_PATCH]: ok({ id: "v-self" }),
    [DEPLOY]: ok({ id: "d1" }),
  });

  it("writes a random BETTER_AUTH_SECRET with the pasted token, then CF_API_TOKEN", async () => {
    const api = fakeCloudflare(withPatch());
    await connect(api, { authSecretBound: false, generateAuthSecret: () => "generated-secret" });
    const puts = api.calls.filter((c) => c.key === `PUT ${A}/workers/scripts/appflare/secrets`);
    expect(puts.map((c) => JSON.parse(c.body ?? "null").name)).toEqual([
      "BETTER_AUTH_SECRET",
      "CF_API_TOKEN",
    ]);
    expect(JSON.parse(puts[0]?.body ?? "null")).toMatchObject({
      type: "secret_text",
      text: "generated-secret",
    });
    // Neither value is kept anywhere but on the Worker.
    const stored = JSON.stringify(await readSettings(createDb(env.DB), Object.values(SETTING)));
    expect(stored).not.toContain("generated-secret");
    expect(stored).not.toContain(TOKEN);
  });

  it("leaves an existing auth secret alone", async () => {
    const api = fakeCloudflare(withPatch());
    await connect(api);
    const puts = api.calls.filter((c) => c.key === `PUT ${A}/workers/scripts/appflare/secrets`);
    expect(puts.map((c) => JSON.parse(c.body ?? "null").name)).toEqual(["CF_API_TOKEN"]);
  });

  it("adds the SELF binding to the Worker itself after the secrets, and deploys it", async () => {
    const api = fakeCloudflare(withPatch());
    const result = await connect(api, { authSecretBound: false, selfBound: false });
    expect(result.selfBinding).toEqual({ added: true, versionId: "v-self" });
    const keys = api.keys();
    expect(keys.indexOf(SELF_PATCH)).toBeGreaterThan(
      keys.lastIndexOf(`PUT ${A}/workers/scripts/appflare/secrets`),
    );
    const patch = api.calls.find((c) => c.key === SELF_PATCH);
    expect(JSON.parse(patch?.body ?? "null").env).toEqual({
      SELF: { type: "service", service: "appflare", entrypoint: "JobUnits" },
    });
    const deploy = api.calls.find((c) => c.key === DEPLOY);
    expect(JSON.parse(deploy?.body ?? "null").versions).toEqual([
      { version_id: "v-self", percentage: 100 },
    ]);
  });

  it("does not touch a Worker that has SELF, and never fails setup over it", async () => {
    const present = fakeCloudflare(withPatch());
    expect((await connect(present)).selfBinding).toEqual({ added: false, reason: "present" });
    expect(present.keys()).not.toContain(SELF_PATCH);

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    const broken = fakeCloudflare({ ...withPatch(), [SELF_PATCH]: { status: 500 } });
    const result = await connect(broken, { selfBound: false });
    expect(result.selfBinding).toEqual({ added: false, reason: "failed" });
    expect(result.claim.value.length).toBeGreaterThan(20);
    expect(broken.keys()).not.toContain(DEPLOY);
  });
});
