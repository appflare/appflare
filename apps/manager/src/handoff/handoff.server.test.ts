import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MANAGER_OAUTH_SCOPES } from "@appflare/cf-api/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectionMemo } from "../cloudflare/connection.server";
import { generateGrantKey, openValue } from "../cloudflare/grant-seal";
import { readGrant } from "../cloudflare/grant-store.server";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { tryAcquireSettingsLock } from "../db/settings-lock";
import { addressRedirectTarget } from "../domains/address-redirect";
import {
  connectCloudflareStep,
  createOwnerStep,
  issueSetupClaim,
  OWNER_CLAIM_TTL_MS,
  redeemOwnerClaim,
  SETUP_MESSAGES,
  setupClaimMatches,
} from "../server/setup.server";
import { ACC } from "../test/fake-account";
import { type FakeRoute, fakeCloudflare } from "../test/fake-cloudflare";
import { fakeOAuth } from "../test/fake-oauth";
import {
  HANDOFF_ATTEMPT_LIMIT,
  HANDOFF_MESSAGES,
  type HandoffEnv,
  handoffResponse,
} from "./handoff.server";
import { handedGrantKey, handoffProof, installerDetailsKey } from "./handoff-proof";
import { readHandoffState } from "./handoff-state.server";
import { completeInstallation, INSTALLER_DETAILS_KEY } from "./installer-completion.server";

/**
 * `/api/handoff` end to end over the framework-free handler: the proof,
 * CORS, the secret, the first handoff (setup's connect step with a grant),
 * a repeat, the owner claim, the address, and reporting the end of setup
 * to the installer. Cloudflare's API and OAuth endpoints are fakes.
 */

// A known answer computed outside this code (Node's crypto): secret = the
// 32 bytes 0..31 in base64url; hash = sha256 of its characters; proof =
// HMAC-SHA256(hash bytes, "appflare-handoff:" + challenge), base64url.
const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const HASH = "ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0";
const CHALLENGE = "challenge-0123456789abcdef";
const PROOF = "xn5hB0PJwzSj5QhpoGLa5KM2v8aQNNUdCqMfmIZO9O0";

const INSTALLER = "https://appflare.dev";
const A = `/accounts/${ACC}`;
const VERSION = "11111111-2222-4333-8444-555555555555";
const WORKERS_DEV = "appflare.appflare-dev.workers.dev";
const DOMAIN = "appflare.example.com";
const CLIENT = "b99863433175d812f9595af56dd1b71d";
const HANDED = "cf-refresh-SECRET-handed-over";
const INSTALLATION = "0b6b2c58-3f2e-4a7e-9a51-0e4c1b2d3f4a";
const INSTALLER_KEY = "SECRET-installer-key-0123456789abcdefghijkl";
const AUTH_SECRET = "generated-auth-SECRET-value";
const NOW = new Date("2026-10-06T12:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const CLAIM_URL = /^https:\/\/([^/]+)\/setup#claim=([A-Za-z0-9_-]{16,256})$/;

const ok = (result: unknown): FakeRoute => ({ result });
const SECRETS = `PUT ${A}/workers/scripts/appflare/secrets`;
const SELF_PATCH = `PATCH ${A}/workers/workers/appflare/versions/latest`;
const DEPLOY = `POST ${A}/workers/scripts/appflare/deployments`;
const DOMAINS = `GET ${A}/workers/domains`;

function world(over: Record<string, FakeRoute | "network-error"> = {}) {
  const api = fakeCloudflare({
    "GET /accounts": ok([{ id: ACC, name: "Appflare Dev" }]),
    [`GET ${A}/workers/scripts`]: ok([{ id: "appflare" }]),
    [`GET ${A}/workers/scripts/appflare/versions/${VERSION}`]: ok({ id: VERSION }),
    [SECRETS]: ok({ name: "x", type: "secret_text" }),
    [SELF_PATCH]: ok({ id: "v-self" }),
    [DEPLOY]: ok({ id: "d1" }),
    [DOMAINS]: ok([
      {
        id: "dom-1",
        hostname: DOMAIN,
        service: "appflare",
        zone_id: "zone-1",
        zone_name: "example.com",
      },
    ]),
    ...over,
  });
  const oauth = fakeOAuth(api.fetch);
  const memo = createConnectionMemo();
  const keys: string[] = [];
  const deps = {
    fetch: oauth.fetch,
    now: () => NOW,
    memo,
    sleep: async () => {},
    generateAuthSecret: () => AUTH_SECRET,
    generateKey: () => {
      const key = generateGrantKey();
      keys.push(key);
      return key;
    },
  };
  return { api, oauth, memo, keys, deps };
}

const managerEnv = (over: Partial<HandoffEnv> = {}): HandoffEnv => ({
  DB: env.DB,
  APPFLARE_VERSION: "1.2.3",
  APPFLARE_HANDOFF: `v1.${HASH}`,
  APPFLARE_INSTALLER_ORIGIN: INSTALLER,
  CF_VERSION_METADATA: { id: VERSION },
  ...over,
});

function handoffBody(over: Record<string, unknown> = {}) {
  return {
    secret: SECRET,
    grant: { refreshToken: HANDED, clientId: CLIENT, scopes: [...MANAGER_OAUTH_SCOPES] },
    accountId: ACC,
    installer: { url: INSTALLER, installationId: INSTALLATION, key: INSTALLER_KEY },
    ...over,
  };
}

function post(
  body: unknown,
  opts: { host?: string; origin?: string | null; ip?: string; type?: string } = {},
): Request {
  const headers = new Headers({ "content-type": opts.type ?? "application/json" });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? INSTALLER);
  headers.set("cf-connecting-ip", opts.ip ?? "203.0.113.7");
  return new Request(`https://${opts.host ?? WORKERS_DEV}/api/handoff`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function get(challenge: string, opts: { host?: string; origin?: string } = {}): Request {
  return new Request(`https://${opts.host ?? WORKERS_DEV}/api/handoff?challenge=${challenge}`, {
    headers: opts.origin === undefined ? {} : { origin: opts.origin },
  });
}

async function addOwner() {
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, email_verified, created_at, updated_at, role, is_owner)
     VALUES ('u1', 'Ada', 'ada@example.com', 0, ?1, ?1, 'admin', 1)`,
  )
    .bind(NOW.getTime())
    .run();
}

async function claimOf(response: Response): Promise<{ host: string; code: string }> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean; ownerSetupUrl: string };
  expect(body.ok).toBe(true);
  const match = CLAIM_URL.exec(body.ownerSetupUrl);
  if (match === null) throw new Error(`not an owner setup URL: ${body.ownerSetupUrl}`);
  return { host: match[1] ?? "", code: match[2] ?? "" };
}

async function settingsRows(): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all<{
    key: string;
    value: string;
  }>();
  return new Map(results.map((r) => [r.key, r.value]));
}

let logged: string[] = [];

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  logged = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => vi.restoreAllMocks());

describe("the proof (GET)", () => {
  it("answers the known vector, with this version and the state", async () => {
    expect(await handoffProof(HASH, CHALLENGE)).toBe(PROOF);
    const response = await handoffResponse(get(CHALLENGE), managerEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      app: "appflare",
      version: "1.2.3",
      state: "waiting",
      proof: PROOF,
    });
  });

  it("is a 404 without APPFLARE_HANDOFF, or with one not in the v1 form", async () => {
    for (const binding of [undefined, "", `v2.${HASH}`, "v1.not-hex"]) {
      const e = managerEnv({ APPFLARE_HANDOFF: binding });
      expect((await handoffResponse(get(CHALLENGE), e)).status).toBe(404);
      expect((await handoffResponse(post(handoffBody()), e)).status).toBe(404);
      const preflight = new Request(`https://${WORKERS_DEV}/api/handoff`, {
        method: "OPTIONS",
        headers: { origin: INSTALLER, "access-control-request-method": "POST" },
      });
      expect((await handoffResponse(preflight, e)).status).toBe(404);
    }
  });

  it("refuses a challenge that is too short, too long or not base64url", async () => {
    for (const challenge of ["short", "x".repeat(65), "has+plus/and=eq-0123456789"]) {
      expect((await handoffResponse(get(encodeURIComponent(challenge)), managerEnv())).status).toBe(
        400,
      );
    }
  });

  it("reports done once an owner exists", async () => {
    await addOwner();
    const body = (await (await handoffResponse(get(CHALLENGE), managerEnv())).json()) as {
      state: string;
    };
    expect(body.state).toBe("done");
  });
});

describe("CORS", () => {
  it("allows exactly the installer's origin, never with credentials", async () => {
    const allowed = await handoffResponse(get(CHALLENGE, { origin: INSTALLER }), managerEnv());
    expect(allowed.headers.get("access-control-allow-origin")).toBe(INSTALLER);
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
    expect(allowed.headers.get("vary")).toBe("Origin");
    for (const origin of ["https://evil.example", "https://appflare.dev.evil.example", "null"]) {
      const other = await handoffResponse(get(CHALLENGE, { origin }), managerEnv());
      // The answer stays readable to the installer's server, not to that page.
      expect(other.status).toBe(200);
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
    }
    // Without the var, no origin is allowed.
    const unset = await handoffResponse(
      get(CHALLENGE, { origin: INSTALLER }),
      managerEnv({ APPFLARE_INSTALLER_ORIGIN: undefined }),
    );
    expect(unset.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers the preflight for the installer's origin only, for GET and POST", async () => {
    const preflight = (origin: string, method: string) =>
      handoffResponse(
        new Request(`https://${WORKERS_DEV}/api/handoff`, {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": method,
            "access-control-request-headers": "content-type",
          },
        }),
        managerEnv(),
      );
    const good = await preflight(INSTALLER, "POST");
    expect(good.status).toBe(204);
    expect(Object.fromEntries(good.headers)).toMatchObject({
      "access-control-allow-origin": INSTALLER,
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "content-type",
      vary: "Origin",
    });
    const wrong = await preflight("https://evil.example", "POST");
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("access-control-allow-origin")).toBeNull();
    expect((await preflight(INSTALLER, "DELETE")).status).toBe(403);
  });

  it("refuses a POST from another origin before anything else", async () => {
    const w = world();
    const response = await handoffResponse(
      post(handoffBody(), { origin: "https://evil.example" }),
      managerEnv(),
      w.deps,
    );
    expect(response.status).toBe(403);
    expect(w.oauth.refreshes).toEqual([]);
    expect(w.api.calls).toEqual([]);
  });

  it("refuses a body that is not JSON", async () => {
    const response = await handoffResponse(
      post("secret=x", { type: "application/x-www-form-urlencoded" }),
      managerEnv(),
    );
    expect(response.status).toBe(415);
  });
});

describe("the secret", () => {
  it("refuses a wrong or missing secret with a fixed message, touching nothing", async () => {
    const w = world();
    const wrongs = [
      { secret: `${SECRET.slice(0, 42)}A` },
      { secret: SECRET.slice(0, 42) },
      { secret: HASH },
      { secret: 42 },
      {},
    ];
    for (const over of wrongs) {
      const body = { ...handoffBody(), secret: undefined, ...over };
      const response = await handoffResponse(post(body), managerEnv(), w.deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "forbidden",
        message: HANDOFF_MESSAGES.forbidden,
      });
    }
    expect(w.oauth.refreshes).toEqual([]);
    expect(w.api.calls).toEqual([]);
    expect(await readGrant(env.DB)).toBeNull();
    expect(await readHandoffState(env.DB)).toBe("waiting");
  });

  it("is rate limited per client address like setup", async () => {
    const w = world();
    const wrong = handoffBody({ secret: "B".repeat(43) });
    for (let i = 0; i < HANDOFF_ATTEMPT_LIMIT.max; i++) {
      expect((await handoffResponse(post(wrong), managerEnv(), w.deps)).status).toBe(403);
    }
    // Even the right secret now waits.
    expect((await handoffResponse(post(handoffBody()), managerEnv(), w.deps)).status).toBe(429);
    // Another address has its own count.
    const other = await handoffResponse(
      post(handoffBody(), { ip: "198.51.100.2" }),
      managerEnv(),
      w.deps,
    );
    expect(other.status).toBe(200);
  });
});

describe("the first handoff", () => {
  it("connects Cloudflare with the grant like setup's connect step, and returns the owner setup URL", async () => {
    const w = world();
    const response = await handoffResponse(post(handoffBody()), managerEnv(), w.deps);
    const { host, code } = await claimOf(response);
    expect(response.headers.get("access-control-allow-origin")).toBe(INSTALLER);
    expect(host).toBe(WORKERS_DEV);
    // Refreshed at once: the manager owns rotation now.
    expect(w.oauth.refreshes).toEqual([{ clientId: CLIENT, refreshToken: HANDED }]);
    // The key, then the missing auth secret, then SELF.
    const secretNames = w.api.calls
      .filter((c) => c.key === SECRETS)
      .map((c) => JSON.parse(c.body ?? "null").name);
    expect(secretNames).toEqual(["CF_GRANT_KEY", "BETTER_AUTH_SECRET"]);
    const keys = w.api.keys();
    expect(keys.indexOf(SELF_PATCH)).toBeGreaterThan(keys.lastIndexOf(SECRETS));
    expect(keys).toContain(DEPLOY);
    // On workers.dev nothing about the address is asked or changed.
    expect(keys).not.toContain(DOMAINS);
    expect((await settingsRows()).get("manager_hostname")).toBeUndefined();
    // Stored and recorded.
    expect(await readGrant(env.DB)).toMatchObject({ clientId: CLIENT, status: "connected" });
    const rows = await settingsRows();
    expect(rows.get("account_id")).toBe(ACC);
    expect(rows.get("worker_name")).toBe("appflare");
    expect(rows.get("cf_token_configured")).toBe("1");
    expect(await readHandoffState(env.DB)).toBe("received");
    // The code is single use and opens owner setup.
    const claim = await redeemOwnerClaim(env.DB, code, NOW);
    expect(claim).not.toBeNull();
    expect(await setupClaimMatches(env.DB, claim?.value, NOW)).toBe(true);
    expect(await redeemOwnerClaim(env.DB, code, NOW)).toBeNull();
  });

  it("needs the grant and the account the first time", async () => {
    const w = world();
    const response = await handoffResponse(
      post(handoffBody({ grant: undefined })),
      managerEnv(),
      w.deps,
    );
    expect(response.status).toBe(400);
    expect(w.oauth.refreshes).toEqual([]);
  });

  it("refuses a grant for an account this Appflare does not run in", async () => {
    const w = world({
      [`GET ${A}/workers/scripts/appflare/versions/${VERSION}`]: {
        status: 404,
        errors: [{ code: 100146, message: "not found" }],
      },
    });
    const response = await handoffResponse(post(handoffBody()), managerEnv(), w.deps);
    expect(response.status).toBe(400);
    expect(await readGrant(env.DB)).toBeNull();
    expect(await readHandoffState(env.DB)).toBe("waiting");
    // The rotated grant nobody holds any more is revoked.
    expect(w.oauth.revokes.length).toBe(1);
    // A refusal that cannot change: nothing is kept for a next try.
    expect((await settingsRows()).get("handoff_grant")).toBeUndefined();
  });

  it("keeps the installer's details sealed, and only for the installer's own origin", async () => {
    const w = world();
    await claimOf(await handoffResponse(post(handoffBody()), managerEnv(), w.deps));
    const stored = JSON.parse((await settingsRows()).get(INSTALLER_DETAILS_KEY) ?? "null") as {
      origin: string;
      installationId: string;
      key: string;
    };
    expect(stored).toMatchObject({ origin: INSTALLER, installationId: INSTALLATION });
    expect(stored.key).not.toContain(INSTALLER_KEY);

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    const elsewhere = handoffBody({
      installer: { url: "https://evil.example", installationId: INSTALLATION, key: INSTALLER_KEY },
    });
    await claimOf(await handoffResponse(post(elsewhere), managerEnv(), world().deps));
    expect((await settingsRows()).get(INSTALLER_DETAILS_KEY)).toBeUndefined();
  });

  it("finishes with the stored grant when an earlier try failed after storing it", async () => {
    const failing = world({ [SELF_PATCH]: ok({ id: "v-self" }) });
    // The auth secret's write fails once: after the grant was stored.
    let secretPuts = 0;
    const fetch: typeof failing.deps.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (init?.method === "PUT" && url.pathname.endsWith("/workers/scripts/appflare/secrets")) {
        secretPuts++;
        if (secretPuts === 2) return new Response("upstream", { status: 500 });
      }
      return failing.deps.fetch(input, init);
    };
    const first = await handoffResponse(post(handoffBody()), managerEnv(), {
      ...failing.deps,
      fetch,
    });
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(await readGrant(env.DB)).not.toBeNull();
    expect(await readHandoffState(env.DB)).toBe("waiting");
    // The browser tries again with the same (now spent) refresh token: the
    // stored grant is used, nothing is refreshed again.
    const again = await handoffResponse(post(handoffBody()), managerEnv(), {
      ...failing.deps,
      fetch,
    });
    await claimOf(again);
    expect(failing.oauth.refreshes).toHaveLength(1);
    expect(await readHandoffState(env.DB)).toBe("received");
  });

  /** The world's fetch, failing the first write of a Worker secret (`CF_GRANT_KEY`). */
  function failingKeyWrite(w: ReturnType<typeof world>) {
    let puts = 0;
    const fetch: typeof w.deps.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (init?.method === "PUT" && url.pathname.endsWith("/workers/scripts/appflare/secrets")) {
        puts++;
        if (puts === 1) return new Response("upstream", { status: 500 });
      }
      return w.deps.fetch(input, init);
    };
    return fetch;
  }

  it("keeps the renewed grant when storing it fails, and the next try starts from it", async () => {
    const w = world();
    const fetch = failingKeyWrite(w);
    const first = await handoffResponse(post(handoffBody()), managerEnv(), { ...w.deps, fetch });
    expect(first.status).toBe(502);
    // Not stored as the connection, not revoked: kept, sealed.
    expect(await readGrant(env.DB)).toBeNull();
    expect(w.oauth.revokes).toEqual([]);
    const kept = (await settingsRows()).get("handoff_grant") ?? "";
    expect(kept).not.toBe("");
    expect(kept).not.toContain("cf-refresh-SECRET-1");
    // The browser sends its spent copy again; the kept one is renewed instead.
    const again = await handoffResponse(post(handoffBody()), managerEnv(), { ...w.deps, fetch });
    await claimOf(again);
    expect(w.oauth.refreshes).toEqual([
      { clientId: CLIENT, refreshToken: HANDED },
      { clientId: CLIENT, refreshToken: "cf-refresh-SECRET-1" },
    ]);
    // Its spent copy is not revoked: that could end the kept grant with it.
    expect(w.oauth.revokes).toEqual([]);
    expect(await readGrant(env.DB)).toMatchObject({ status: "connected" });
    expect((await settingsRows()).get("handoff_grant")).toBeUndefined();
  });

  it("keeps it where only the handoff secret opens it, not what the installer knows", async () => {
    const w = world();
    const fetch = failingKeyWrite(w);
    expect(
      (await handoffResponse(post(handoffBody()), managerEnv(), { ...w.deps, fetch })).status,
    ).toBe(502);
    const row = JSON.parse((await settingsRows()).get("handoff_grant") ?? "null") as {
      salt: string;
      sealed: string;
    };
    const salt = Uint8Array.from(atob(row.salt.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    const context = "appflare-handoff-grant";
    // Everything the hosted installer knows: the binding it wrote, and its hash.
    for (const key of [
      await installerDetailsKey(HASH),
      await handedGrantKey(`v1.${HASH}`, salt),
      await handedGrantKey(HASH, salt),
    ]) {
      await expect(openValue(key, row.sealed, context)).rejects.toThrow();
    }
    // The browser's secret does.
    const opened = JSON.parse(
      await openValue(await handedGrantKey(SECRET, salt), row.sealed, context),
    ) as { refreshToken: string };
    expect(opened.refreshToken).toBe("cf-refresh-SECRET-1");
  });

  it("withdraws a new authorization sent along while the kept one carries on", async () => {
    const w = world();
    const fetch = failingKeyWrite(w);
    expect(
      (await handoffResponse(post(handoffBody()), managerEnv(), { ...w.deps, fetch })).status,
    ).toBe(502);
    const fresh = handoffBody({
      grant: { refreshToken: "cf-refresh-SECRET-fresh", clientId: CLIENT, scopes: [] },
    });
    await claimOf(await handoffResponse(post(fresh), managerEnv(), { ...w.deps, fetch }));
    // The kept one was used, and the new one, never refreshed, was revoked.
    expect(w.oauth.refreshes.map((r) => r.refreshToken)).toEqual([HANDED, "cf-refresh-SECRET-1"]);
    expect(w.oauth.revokes).toEqual([
      { clientId: CLIENT, refreshToken: "cf-refresh-SECRET-fresh" },
    ]);
  });

  it("revokes a renewed authorization it could not keep when storing it then fails", async () => {
    const w = world();
    // Keeping it fails (D1 refuses that one write), and the connection is busy.
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("INSERT INTO settings")) return statement;
          return new Proxy(statement, {
            get(s, p, r) {
              if (p !== "bind") return Reflect.get(s, p, r);
              return (...args: unknown[]) =>
                args[0] === "handoff_grant"
                  ? { run: () => Promise.reject(new Error("D1 is unavailable")) }
                  : s.bind(...args);
            },
          });
        };
      },
    });
    expect(await tryAcquireSettingsLock(env.DB, "cf_token_lock", "other", 60_000)).toBe(true);
    const response = await handoffResponse(post(handoffBody()), managerEnv({ DB: db }), w.deps);
    expect(response.status).toBe(503);
    expect(w.oauth.revokes).toEqual([{ clientId: CLIENT, refreshToken: "cf-refresh-SECRET-1" }]);
    expect((await settingsRows()).get("handoff_grant")).toBeUndefined();
  });

  it("forgets a kept grant once the owner exists", async () => {
    const w = world();
    const fetch = failingKeyWrite(w);
    expect(
      (await handoffResponse(post(handoffBody()), managerEnv(), { ...w.deps, fetch })).status,
    ).toBe(502);
    // Setup finished some other way (an API token): the owner is created.
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('cf_token_configured', '1', 0)`,
    ).run();
    const claim = await issueSetupClaim(env.DB, NOW);
    await createOwnerStep({
      d1: env.DB,
      claimCookie: claim.value,
      now: NOW,
      authReady: true,
      input: { email: "ada@example.com", name: "Ada", password: "a-long-password" },
      createUser: async () => {
        await addOwner();
        return { id: "u1" };
      },
    });
    expect((await settingsRows()).get("handoff_grant")).toBeUndefined();
  });

  it("forgets a kept grant that a new handoff secret cannot open, and goes on with the new grant", async () => {
    const w = world();
    const fetch = failingKeyWrite(w);
    expect(
      (await handoffResponse(post(handoffBody()), managerEnv(), { ...w.deps, fetch })).status,
    ).toBe(502);
    // The browser lost its secret; the installer put a new one's hash on the Worker.
    const secret2 = "Z".repeat(43);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret2));
    const hash2 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const rotated = managerEnv({ APPFLARE_HANDOFF: `v1.${hash2}` });
    // With only the spent grant: nothing usable, sign in again.
    w.oauth.next.push("invalid_grant");
    const spent = await handoffResponse(post(handoffBody({ secret: secret2 })), rotated, {
      ...w.deps,
      fetch,
    });
    expect(spent.status).toBe(401);
    expect((await settingsRows()).get("handoff_grant")).toBeUndefined();
    // With a new authorization: connected.
    const fresh = handoffBody({
      secret: secret2,
      grant: { refreshToken: "cf-refresh-SECRET-fresh", clientId: CLIENT, scopes: [] },
    });
    await claimOf(await handoffResponse(post(fresh), rotated, { ...w.deps, fetch }));
    // The old kept token was never sent: nobody could open it.
    expect(w.oauth.refreshes.map((r) => r.refreshToken)).toEqual([
      HANDED,
      HANDED,
      "cf-refresh-SECRET-fresh",
    ]);
  });

  it("asks for a new authorization when the browser's is spent and none is kept", async () => {
    const w = world();
    w.oauth.next.push("invalid_grant");
    const spent = await handoffResponse(post(handoffBody()), managerEnv(), w.deps);
    expect(spent.status).toBe(401);
    expect(await spent.json()).toMatchObject({ error: "authorize_again" });
    expect(spent.headers.get("access-control-allow-origin")).toBe(INSTALLER);
    expect(await readHandoffState(env.DB)).toBe("waiting");
    // Signed in again: the new authorization goes through.
    const fresh = handoffBody({
      grant: { refreshToken: "cf-refresh-SECRET-fresh", clientId: CLIENT, scopes: [] },
    });
    await claimOf(await handoffResponse(post(fresh), managerEnv(), w.deps));
  });

  it("falls back to a new authorization when the kept one no longer works", async () => {
    const w = world();
    const fetch = failingKeyWrite(w);
    expect(
      (await handoffResponse(post(handoffBody()), managerEnv(), { ...w.deps, fetch })).status,
    ).toBe(502);
    w.oauth.next.push("invalid_grant");
    const fresh = handoffBody({
      grant: { refreshToken: "cf-refresh-SECRET-fresh", clientId: CLIENT, scopes: [] },
    });
    await claimOf(await handoffResponse(post(fresh), managerEnv(), { ...w.deps, fetch }));
    expect(w.oauth.refreshes.map((r) => r.refreshToken)).toEqual([
      HANDED,
      "cf-refresh-SECRET-1",
      "cf-refresh-SECRET-fresh",
    ]);
  });

  it("says another browser is finishing setup, with the minutes left", async () => {
    const w = world();
    await issueSetupClaim(env.DB, later(-10 * 60_000));
    const response = await handoffResponse(post(handoffBody()), managerEnv(), w.deps);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "setup_elsewhere", minutes: 20 });
    expect(w.oauth.refreshes).toEqual([]);
  });

  it("asks to try again later while another change holds the lock", async () => {
    const w = world();
    expect(await tryAcquireSettingsLock(env.DB, "setup_connect_lock", "other", 60_000)).toBe(true);
    const response = await handoffResponse(post(handoffBody()), managerEnv(), w.deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toMatchObject({ error: "busy" });
    expect(w.oauth.refreshes).toEqual([]);
  });

  it("stops reading a body past 16 KiB, with or without Content-Length", async () => {
    const big = new TextEncoder().encode(JSON.stringify(handoffBody({ pad: "x".repeat(20_000) })));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < big.length; i += 1024) controller.enqueue(big.slice(i, i + 1024));
        controller.close();
      },
    });
    const request = new Request(`https://${WORKERS_DEV}/api/handoff`, {
      method: "POST",
      headers: { origin: INSTALLER, "content-type": "application/json" },
      body: stream,
    });
    expect(request.headers.get("content-length")).toBeNull();
    expect((await handoffResponse(request, managerEnv(), world().deps)).status).toBe(413);
    expect(
      (await handoffResponse(post(handoffBody({ pad: "x".repeat(20_000) })), managerEnv())).status,
    ).toBe(413);
  });
});

describe("a repeat handoff", () => {
  it("leaves the grant alone and issues a fresh claim; the grant may be omitted", async () => {
    const w = world();
    const first = await claimOf(await handoffResponse(post(handoffBody()), managerEnv(), w.deps));
    const grant = await readGrant(env.DB);
    const calls = w.api.calls.length;

    const again = await claimOf(
      await handoffResponse(
        post({ secret: SECRET, accountId: ACC }),
        managerEnv({ CF_GRANT_KEY: w.keys[0] }),
        w.deps,
      ),
    );
    expect(again.code).not.toBe(first.code);
    expect(w.oauth.refreshes).toHaveLength(1);
    expect(w.api.calls.length).toBe(calls);
    expect(await readGrant(env.DB)).toEqual(grant);
    // Only the newest code works.
    expect(await redeemOwnerClaim(env.DB, first.code, NOW)).toBeNull();
    expect(await redeemOwnerClaim(env.DB, again.code, NOW)).not.toBeNull();
  });

  it("is refused with 409 once an owner exists", async () => {
    const w = world();
    await claimOf(await handoffResponse(post(handoffBody()), managerEnv(), w.deps));
    await addOwner();
    const response = await handoffResponse(post(handoffBody()), managerEnv(), w.deps);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "done" });
    // Even without the secret: once done, every POST is refused.
    const anyone = await handoffResponse(post({ secret: "nope" }), managerEnv(), w.deps);
    expect(anyone.status).toBe(409);
    expect(w.oauth.refreshes).toHaveLength(1);
  });
});

describe("the owner claim", () => {
  it("expires after 30 minutes", async () => {
    const w = world();
    const { code } = await claimOf(
      await handoffResponse(post(handoffBody()), managerEnv(), w.deps),
    );
    expect(await redeemOwnerClaim(env.DB, code, later(OWNER_CLAIM_TTL_MS))).toBeNull();
  });

  it("holds off a pasted token while it is unused, as another browser's setup claim does", async () => {
    const w = world();
    await claimOf(await handoffResponse(post(handoffBody()), managerEnv(), w.deps));
    const api = fakeCloudflare({});
    const pasted = connectCloudflareStep({
      token: { db: env.DB, token: "cf-api-token-SECRET", host: WORKERS_DEV, fetch: api.fetch },
      client: "198.51.100.9",
      now: NOW,
      claimCookie: undefined,
      currentToken: undefined,
      authSecretBound: true,
      selfBound: true,
    });
    await expect(pasted).rejects.toThrow(SETUP_MESSAGES.inProgress(30));
    expect(api.calls).toEqual([]);
  });

  it("is not exchanged once an owner exists", async () => {
    const w = world();
    const { code } = await claimOf(
      await handoffResponse(post(handoffBody()), managerEnv(), w.deps),
    );
    await addOwner();
    expect(await redeemOwnerClaim(env.DB, code, NOW)).toBeNull();
  });
});

describe("Appflare's address", () => {
  it("becomes the custom domain of this Worker the handoff arrived on", async () => {
    const w = world();
    const { host } = await claimOf(
      await handoffResponse(post(handoffBody(), { host: DOMAIN }), managerEnv(), w.deps),
    );
    expect(host).toBe(DOMAIN);
    const rows = await settingsRows();
    expect(rows.get("manager_hostname")).toBe(DOMAIN);
    expect(rows.get("manager_domain_id")).toBe("dom-1");
    expect(rows.get("manager_zone_id")).toBe("zone-1");
    // Nothing was left behind: this is the address people use.
    expect(rows.get("manager_previous_hostname")).toBeUndefined();
    // workers.dev now redirects pages there, but never this API.
    expect(
      addressRedirectTarget({ method: "GET", url: `https://${WORKERS_DEV}/` }, DOMAIN, "appflare"),
    ).toBe(`https://${DOMAIN}/`);
    expect(
      addressRedirectTarget(
        { method: "GET", url: `https://${WORKERS_DEV}/api/handoff?challenge=${CHALLENGE}` },
        DOMAIN,
        "appflare",
      ),
    ).toBeNull();
  });

  it("stays as it is on a hostname that is not a custom domain of this Worker", async () => {
    const w = world({ [DOMAINS]: ok([]) });
    await claimOf(
      await handoffResponse(post(handoffBody(), { host: DOMAIN }), managerEnv(), w.deps),
    );
    expect((await settingsRows()).get("manager_hostname")).toBeUndefined();
  });
});

describe("reporting the end of setup to the installer", () => {
  function installerFake(statuses: Array<number | "network-error">) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, body: await request.json() });
      const status = statuses.shift() ?? 200;
      if (status === "network-error") throw new TypeError("fetch failed");
      return new Response(null, { status });
    };
    return { fetch, calls };
  }

  it("waits for the owner, then retries until 2xx and forgets the details", async () => {
    const w = world();
    await claimOf(await handoffResponse(post(handoffBody()), managerEnv(), w.deps));
    const installer = installerFake([500, "network-error", 204]);
    const e = managerEnv();
    expect(await completeInstallation(e, installer)).toBe("waiting");
    expect(installer.calls).toEqual([]);
    await addOwner();
    expect(await completeInstallation(e, installer)).toBe("failed");
    expect(await completeInstallation(e, installer)).toBe("failed");
    expect(await completeInstallation(e, installer)).toBe("completed");
    expect(installer.calls[0]).toEqual({
      url: `${INSTALLER}/api/install/installations/${INSTALLATION}/complete`,
      body: { key: INSTALLER_KEY },
    });
    expect((await settingsRows()).get(INSTALLER_DETAILS_KEY)).toBeUndefined();
    expect(await completeInstallation(e, installer)).toBe("none");
    expect(installer.calls).toHaveLength(3);
  });

  it("stops asking on an answer that cannot change, and keeps asking on 429 and 5xx", async () => {
    for (const status of [400, 401, 403]) {
      await reset();
      await createMigrator(migrations).ensure(env.DB);
      await claimOf(await handoffResponse(post(handoffBody()), managerEnv(), world().deps));
      await addOwner();
      const installer = installerFake([429, 503, status]);
      expect(await completeInstallation(managerEnv(), installer)).toBe("failed");
      expect(await completeInstallation(managerEnv(), installer)).toBe("failed");
      expect(await completeInstallation(managerEnv(), installer)).toBe("refused");
      expect((await settingsRows()).get(INSTALLER_DETAILS_KEY)).toBeUndefined();
      expect(await completeInstallation(managerEnv(), installer)).toBe("none");
      expect(installer.calls).toHaveLength(3);
    }
    for (const line of logged) expect(line).not.toContain(INSTALLER_KEY);
  });

  it("keeps no details whose key is not in the installer's format", async () => {
    const odd = handoffBody({
      installer: { url: INSTALLER, installationId: INSTALLATION, key: "too-short" },
    });
    await claimOf(await handoffResponse(post(odd), managerEnv(), world().deps));
    expect((await settingsRows()).get(INSTALLER_DETAILS_KEY)).toBeUndefined();
  });

  it("forgets the details when the installer no longer has the record", async () => {
    const w = world();
    await claimOf(await handoffResponse(post(handoffBody()), managerEnv(), w.deps));
    await addOwner();
    const installer = installerFake([404]);
    expect(await completeInstallation(managerEnv(), installer)).toBe("gone");
    expect((await settingsRows()).get(INSTALLER_DETAILS_KEY)).toBeUndefined();
  });
});

describe("secrets", () => {
  it("never logs or stores the secret, a token, the code or the installer's key", async () => {
    const w = world();
    const first = await claimOf(
      await handoffResponse(post(handoffBody(), { host: DOMAIN }), managerEnv(), w.deps),
    );
    const again = await claimOf(
      await handoffResponse(post({ secret: SECRET }), managerEnv(), w.deps),
    );
    await handoffResponse(post(handoffBody({ secret: "C".repeat(43) })), managerEnv(), w.deps);
    const redeemed = await redeemOwnerClaim(env.DB, again.code, NOW);
    await addOwner();
    await completeInstallation(managerEnv(), {
      fetch: async () => new Response(null, { status: 200 }),
    });

    const secrets = [
      SECRET,
      HASH,
      HANDED,
      INSTALLER_KEY,
      AUTH_SECRET,
      first.code,
      again.code,
      redeemed?.value ?? "missing",
      ...w.keys,
      ...w.oauth.issued,
    ];
    const tables = ["settings", "cloudflare_grant", "rate_limit"];
    let stored = "";
    for (const table of tables) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      stored += JSON.stringify(results);
    }
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
      for (const line of logged) expect(line).not.toContain(secret);
    }
    expect(logged.length).toBeGreaterThan(0);
  });
});
