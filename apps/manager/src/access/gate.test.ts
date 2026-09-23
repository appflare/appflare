import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  AUD,
  certsFetch,
  createTestAccessTeam,
  TEAM_DOMAIN,
  type TestAccessTeam,
} from "../test/access-jwt";
import { type AccessConfig, clearAccessConfig, writeAccessConfig } from "./config";
import { type AccessGate, createAccessGate } from "./gate";
import { createAccessKeyStore } from "./keys";

const HOST = "appflare.appflare-dev.workers.dev";
const CONFIG: AccessConfig = {
  appId: "app-1",
  policyId: "pol-1",
  healthAppId: "app-health",
  aud: AUD,
  teamDomain: TEAM_DOMAIN,
  domain: HOST,
  enabledAt: "2026-09-23T12:00:00.000Z",
};

let team: TestAccessTeam;
let clock: number;
let certs: ReturnType<typeof certsFetch>;
let published: TestAccessTeam[];
let gate: AccessGate;

function request(path: string, init: { token?: string; accept?: string } = {}): Request {
  const headers = new Headers();
  if (init.token !== undefined) headers.set("Cf-Access-Jwt-Assertion", init.token);
  if (init.accept !== undefined) headers.set("Accept", init.accept);
  return new Request(`https://${HOST}${path}`, { headers });
}

beforeAll(async () => {
  team = await createTestAccessTeam("kid-1");
});

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  clock = Date.parse("2026-09-23T12:00:00.000Z");
  published = [team];
  certs = certsFetch(() => ({ keys: published.flatMap((t) => t.jwks.keys) }));
  gate = createAccessGate({
    keys: createAccessKeyStore({ fetch: certs.fetch, now: () => clock }),
    now: () => clock,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("access gate, protection off", () => {
  it("lets every request through without reading a token", async () => {
    expect(await gate.check(request("/_serverFn/abc"), env.DB)).toBeNull();
    expect(certs.calls).toHaveLength(0);
  });
});

describe("access gate, protection on", () => {
  beforeEach(async () => {
    await writeAccessConfig(env.DB, CONFIG);
  });

  it("lets a request with a valid Access token through", async () => {
    const token = await team.sign(team.claims(clock));
    expect(await gate.check(request("/_serverFn/abc", { token }), env.DB)).toBeNull();
    expect(certs.calls).toEqual([`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`]);
  });

  it("refuses a request without the header with a 403 page", async () => {
    const response = await gate.check(request("/", { accept: "text/html" }), env.DB);
    expect(response?.status).toBe(403);
    expect(response?.headers.get("content-type")).toContain("text/html");
    const html = (await response?.text()) ?? "";
    expect(html).toContain("Sign in with Cloudflare Access");
    expect(html).toContain(`https://${HOST}/`);
    expect(html).toContain("DELETE FROM settings WHERE key LIKE &#39;access_%&#39;");
  });

  it("answers non-browser requests with JSON", async () => {
    const response = await gate.check(request("/_serverFn/abc"), env.DB);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ reason: "missing" });
  });

  it("refuses an expired token", async () => {
    const token = await team.sign(team.claims(clock - 7_200_000));
    const response = await gate.check(request("/api/auth/get-session", { token }), env.DB);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ reason: "expired" });
  });

  it("refuses a token for another application", async () => {
    const token = await team.sign(team.claims(clock, { aud: ["someone-elses-app"] }));
    const response = await gate.check(request("/_serverFn/abc", { token }), env.DB);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ reason: "wrong-audience" });
  });

  it("exempts /api/health, and only that exact path", async () => {
    expect(await gate.check(request("/api/health"), env.DB)).toBeNull();
    expect((await gate.check(request("/api/health/extra"), env.DB))?.status).toBe(403);
    expect((await gate.check(request("/api/healthz"), env.DB))?.status).toBe(403);
    expect(certs.calls).toHaveLength(0);
  });

  it("never logs the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const token = await team.sign(team.claims(clock, { aud: ["other"] }));
    await gate.check(request("/_serverFn/abc?x=1", { token }), env.DB);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("wrong-audience");
    expect(logged).not.toContain(token.split(".")[2] ?? "");
    expect(logged).not.toContain("x=1");
  });

  it("reads the setting once per cache period, and again after invalidate", async () => {
    await clearAccessConfig(env.DB);
    // Cached as off.
    expect(await gate.check(request("/x"), env.DB)).toBeNull();
    await writeAccessConfig(env.DB, CONFIG);
    expect(await gate.check(request("/x"), env.DB)).toBeNull();
    clock += 16_000;
    expect((await gate.check(request("/x"), env.DB))?.status).toBe(403);
    expect(
      await gate.check(request("/x", { token: await team.sign(team.claims(clock)) }), env.DB),
    ).toBeNull();
    // Turned off in this isolate: invalidate makes it effective at once.
    await clearAccessConfig(env.DB);
    gate.invalidate();
    expect(await gate.check(request("/x"), env.DB)).toBeNull();
  });

  it("refetches the keys once when a token names a key it has not seen", async () => {
    const first = await team.sign(team.claims(clock));
    expect(await gate.check(request("/x", { token: first }), env.DB)).toBeNull();
    expect(certs.calls).toHaveLength(1);

    // Access rotates: a new key is published and signs new tokens.
    const rotated = await createTestAccessTeam("kid-2");
    published = [team, rotated];
    clock += 61_000;
    const second = await rotated.sign(rotated.claims(clock));
    expect(await gate.check(request("/x", { token: second }), env.DB)).toBeNull();
    expect(certs.calls).toHaveLength(2);

    // Unknown key ids do not refetch again within the refresh interval.
    const stranger = await createTestAccessTeam("kid-unknown");
    const forged = await stranger.sign(stranger.claims(clock));
    const response = await gate.check(request("/x", { token: forged }), env.DB);
    expect(await response?.json()).toMatchObject({ reason: "unknown-key" });
    expect(certs.calls).toHaveLength(2);
  });

  it("fails closed when the team's keys cannot be fetched", async () => {
    const failing = createAccessGate({
      keys: createAccessKeyStore({
        fetch: async () => new Response("unavailable", { status: 503 }),
        now: () => clock,
      }),
      now: () => clock,
    });
    const token = await team.sign(team.claims(clock));
    const response = await failing.check(request("/x", { token }), env.DB);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ reason: "keys-unavailable" });
  });

  it("does not refetch the keys on every request after a failed first fetch", async () => {
    let calls = 0;
    let up = false;
    const failing = createAccessGate({
      keys: createAccessKeyStore({
        fetch: async (input) => {
          calls += 1;
          return up ? certs.fetch(input) : new Response("unavailable", { status: 503 });
        },
        now: () => clock,
      }),
      now: () => clock,
    });
    const token = await team.sign(team.claims(clock));
    for (let i = 0; i < 5; i++) {
      expect((await failing.check(request("/x", { token }), env.DB))?.status).toBe(403);
    }
    expect(calls).toBe(1);

    up = true;
    clock += 5_000;
    expect((await failing.check(request("/x", { token }), env.DB))?.status).toBe(403);
    expect(calls).toBe(1);
    clock += 6_000;
    expect(await failing.check(request("/x", { token }), env.DB)).toBeNull();
    expect(calls).toBe(2);
  });

  it("fails closed when the setting cannot be read and nothing is cached", async () => {
    const broken = createAccessGate({
      readConfig: async () => {
        throw new Error("D1 unavailable");
      },
    });
    const response = await broken.check(request("/x"), env.DB);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ reason: "settings-unavailable" });
    expect(await broken.check(request("/api/health"), env.DB)).toBeNull();
  });
});
