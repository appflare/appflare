import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { writeAccessConfig } from "../access/config";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { ACC, TOKEN } from "../test/fake-account";
import {
  changeManagerAddress,
  listAddressOptions,
  type ManagerAddressDeps,
  moveManagerAddress,
  readManagerAddress,
  reconcileManagerAddress,
  revertManagerAddress,
  waitForManager,
} from "./manager-address.server";

/**
 * Appflare's address against the local D1 and a stateful fake of the zones,
 * DNS records, Workers custom domains and Access applications API, with the
 * new hostname's health endpoint answered from what is attached.
 */

const NOW = new Date("2026-09-28T12:00:00.000Z");
const VERSION = "1.4.0";
const WORKER = "appflare";
const WORKERS_DEV = "appflare.ada.workers.dev";
const HOST = "appflare.example.com";

interface Domain {
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
}

interface AccessAppRow {
  id: string;
  aud: string;
  name: string;
  domain: string;
  policies: Array<{ id: string }>;
}

interface World {
  domains: Map<string, Domain>;
  records: Record<string, Array<{ id: string; type: string; name: string; content: string }>>;
  apps: AccessAppRow[];
  /** `METHOD /path` answered with this status and code 10000. */
  refuse: Map<string, number>;
  /** How the health endpoint answers: `serve` answers as the manager whose version is given. */
  health: { kind: "serve"; version: string } | { kind: "down" } | { kind: "edge-1042" };
  /** PUT /access/apps answers with no policies (a policy must be made again). */
  dropPolicies: boolean;
  calls: string[];
  bodies: Array<{ key: string; body: unknown }>;
  probes: string[];
}

function fakeWorld(over: Partial<World> = {}) {
  const world: World = {
    domains: new Map(),
    records: {},
    apps: [],
    refuse: new Map(),
    health: { kind: "serve", version: VERSION },
    dropPolicies: false,
    calls: [],
    bodies: [],
    probes: [],
    ...over,
  };
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, code: number, message: string) =>
    Response.json({ success: false, errors: [{ code, message }], messages: [] }, { status });
  const zones = [
    { id: "z-a", name: "example.com", status: "active", account: { id: ACC } },
    { id: "z-b", name: "beta.dev", status: "active", account: { id: ACC } },
  ];

  const api = async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace("/client/v4", "").replace(`/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    world.calls.push(`${key}${url.search}`);
    const refused = world.refuse.get(key);
    if (refused !== undefined) return fail(refused, 10000, "Authentication error");
    if (request.method === "PUT" || request.method === "POST") {
      world.bodies.push({ key, body: await request.clone().json() });
    }
    if (key === "GET /zones") {
      return ok(zones, { result_info: { page: 1, per_page: 50, total_pages: 1 } });
    }
    let m = /^GET \/zones\/([^/]+)$/.exec(key);
    if (m?.[1]) {
      const zone = zones.find((z) => z.id === m?.[1]);
      return zone === undefined ? fail(404, 1001, "Invalid zone") : ok(zone);
    }
    m = /^GET \/zones\/([^/]+)\/dns_records$/.exec(key);
    if (m?.[1]) {
      const name = url.searchParams.get("name.exact");
      return ok(
        (world.records[m[1]] ?? []).filter((r) => r.name === name),
        { result_info: { page: 1, total_pages: 1 } },
      );
    }
    if (/^GET \/zones\/[^/]+\/workers\/routes$/.test(key)) return ok([]);
    if (key === "GET /workers/subdomain") return ok({ subdomain: "ada" });
    if (key === "GET /workers/domains") {
      const hostname = url.searchParams.get("hostname");
      const service = url.searchParams.get("service");
      return ok(
        [...world.domains]
          .filter(([, d]) => hostname === null || d.hostname === hostname)
          .filter(([, d]) => service === null || d.service === service)
          .map(([id, d]) => ({ id, ...d, environment: "production" })),
      );
    }
    if (key === "PUT /workers/domains") {
      const body = (await request.json()) as { hostname: string; service: string; zone_id: string };
      const id = `dom-${world.domains.size + 1}`;
      world.domains.set(id, { ...body, zone_name: "example.com" });
      return ok({ id, ...body, zone_name: "example.com" });
    }
    m = /^DELETE \/workers\/domains\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.domains.delete(m[1]) ? ok(null) : fail(404, 100114, "not found");
    if (key === "GET /access/apps") {
      return ok(world.apps, { result_info: { page: 1, per_page: 50, total_pages: 1 } });
    }
    m = /^PUT \/access\/apps\/([^/]+)$/.exec(key);
    if (m?.[1]) {
      const app = world.apps.find((a) => a.id === m?.[1]);
      if (app === undefined) return fail(404, 12130, "not found");
      const body = (await request.json()) as { name: string; domain: string };
      app.name = body.name;
      app.domain = body.domain;
      if (world.dropPolicies) app.policies = [];
      return ok(app);
    }
    m = /^POST \/access\/apps\/([^/]+)\/policies$/.exec(key);
    if (m?.[1]) {
      const app = world.apps.find((a) => a.id === m?.[1]);
      const policy = { id: `pol-new-${world.calls.length}` };
      app?.policies.push(policy);
      return ok(policy);
    }
    return fail(404, 7003, `no route ${key}`);
  };

  /** The new hostname's `/api/health`. */
  const fetch = async (input: string): Promise<Response> => {
    const url = new URL(input);
    world.probes.push(url.href);
    const attached = [...world.domains.values()].some(
      (d) => d.hostname === url.hostname && d.service === WORKER,
    );
    if (!attached || world.health.kind === "down") throw new Error("connection refused");
    if (world.health.kind === "edge-1042") {
      return new Response("error code: 1042", { status: 404 });
    }
    return Response.json({ version: world.health.version, db: "ok" });
  };

  const client = createClient({ accountId: ACC, token: TOKEN, fetch: api });
  return { world, api: client, fetch };
}

function deps(w: ReturnType<typeof fakeWorld>): ManagerAddressDeps & { slept: number[] } {
  let clock = NOW.getTime();
  const slept: number[] = [];
  return {
    db: env.DB,
    api: w.api,
    fetch: w.fetch,
    version: VERSION,
    now: () => new Date(clock),
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
    slept,
  };
}

async function setting(key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function addressRows() {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key LIKE 'manager_%' AND key <> 'manager_version_history'
     AND key NOT LIKE 'manager_domain_attached_by:%' ORDER BY key`,
  ).all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

async function passkeyHosts() {
  const { results } = await env.DB.prepare(
    "SELECT passkey_id, hostname FROM passkey_host ORDER BY passkey_id",
  ).all();
  return results;
}

async function addPasskey(id: string) {
  await env.DB.prepare(
    `INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
     VALUES (?1, 'k', 'u1', ?1, 0, 'singleDevice', 0)`,
  )
    .bind(id)
    .run();
}

/** Access on for `domain`, with its two applications in the fake account. */
async function accessOn(world: World, domain: string) {
  world.apps.push(
    {
      id: "app-main",
      aud: "aud-1",
      name: `Appflare (${domain})`,
      domain,
      policies: [{ id: "pol-1" }],
    },
    {
      id: "app-health",
      aud: "aud-h",
      name: `Appflare health check (${domain})`,
      domain: `${domain}/api/health`,
      policies: [{ id: "pol-h" }],
    },
  );
  await writeAccessConfig(env.DB, {
    appId: "app-main",
    policyId: "pol-1",
    healthAppId: "app-health",
    aud: "aud-1",
    teamDomain: "ada.cloudflareaccess.com",
    domain,
    enabledAt: NOW.toISOString(),
  });
}

/** Appflare already at `hostname`, attached as `dom-0`. */
async function movedTo(world: World, hostname: string) {
  world.domains.set("dom-0", {
    hostname,
    service: WORKER,
    zone_id: "z-a",
    zone_name: "example.com",
  });
  await writeSettings(createDb(env.DB), {
    [SETTING.managerHostname]: hostname,
    [SETTING.managerDomainId]: "dom-0",
    [SETTING.managerZoneId]: "z-a",
    [SETTING.managerPreviousHostname]: WORKERS_DEV,
    [SETTING.managerMovedAt]: "2026-09-01T00:00:00.000Z",
  });
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: WORKER,
    [SETTING.accountSubdomain]: "ada",
  });
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
     VALUES ('u1', 'Ada', 'ada@example.com', 0, 'admin', 0, 0)`,
  ).run();
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('notification_manager_url', 'https://appflare.ada.workers.dev', 0)",
  ).run();
});

describe("moveManagerAddress", () => {
  it("attaches the hostname, waits for this version there, then switches", async () => {
    const w = fakeWorld();
    await addPasskey("pk1");
    const d = deps(w);
    const result = await moveManagerAddress(d, {
      zoneId: "z-a",
      hostname: " Appflare.Example.com ",
      returnTo: "/settings/domains#address",
    });
    expect(result).toEqual({
      ok: true,
      hostname: HOST,
      url: `https://${HOST}/login?returnTo=%2Fsettings%2Fdomains%23address&moved=1`,
    });
    expect(w.world.calls).toEqual([
      "GET /zones/z-a",
      `GET /workers/domains?hostname=${HOST}`,
      `GET /workers/domains?hostname=${HOST}`,
      `GET /zones/z-a/dns_records?name.exact=${HOST}&page=1&per_page=100`,
      "PUT /workers/domains",
    ]);
    expect(w.world.bodies[0]?.body).toEqual({
      zone_id: "z-a",
      hostname: HOST,
      service: WORKER,
      environment: "production",
    });
    expect(w.world.probes).toEqual([`https://${HOST}/api/health`]);
    expect(await addressRows()).toEqual({
      manager_domain_id: "dom-1",
      manager_hostname: HOST,
      manager_moved_at: NOW.toISOString(),
      manager_previous_hostname: WORKERS_DEV,
      manager_zone_id: "z-a",
    });
    // Links no longer point at the old address, and the passkey is marked as the old address's.
    expect(await setting("notification_manager_url")).toBeNull();
    expect(await passkeyHosts()).toEqual([{ passkey_id: "pk1", hostname: WORKERS_DEV }]);
  });

  it("answers dns-conflict with the records, and replaces them only when asked", async () => {
    const w = fakeWorld({
      records: { "z-a": [{ id: "r1", type: "A", name: HOST, content: "192.0.2.1" }] },
    });
    const conflict = await moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST });
    expect(conflict).toEqual({
      ok: false,
      reason: "dns-conflict",
      hostname: HOST,
      records: [{ type: "A", content: "192.0.2.1" }],
    });
    expect(w.world.calls).not.toContain("PUT /workers/domains");
    expect(await addressRows()).toEqual({});

    const moved = await moveManagerAddress(deps(w), {
      zoneId: "z-a",
      hostname: HOST,
      overrideExistingDnsRecord: true,
    });
    expect(moved.ok).toBe(true);
    expect(w.world.bodies.at(-1)?.body).toMatchObject({ override_existing_dns_record: true });
  });

  it("detaches the domain again and changes nothing when it never answers as this manager", async () => {
    const w = fakeWorld({ health: { kind: "edge-1042" } });
    await addPasskey("pk1");
    const d = deps(w);
    await expect(moveManagerAddress(d, { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      `${HOST} did not answer as this Appflare within 90 seconds (last answer: HTTP 404, error code 1042). Appflare stays at ${WORKERS_DEV}. Appflare removed the domain again.`,
    );
    // The install's live-check backoff, within its window.
    expect(d.slept).toEqual([
      2000, 3000, 5000, 8000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
    ]);
    expect(w.world.calls.at(-1)).toBe("DELETE /workers/domains/dom-1");
    expect(w.world.domains.size).toBe(0);
    expect(await addressRows()).toEqual({});
    expect(await setting("notification_manager_url")).toBe("https://appflare.ada.workers.dev");
    expect(await passkeyHosts()).toEqual([]);
  });

  it("does not count another version's answer as this manager", async () => {
    const w = fakeWorld({ health: { kind: "serve", version: "1.3.9" } });
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "last answer: Appflare 1.3.9, not 1.4.0",
    );
    expect(await addressRows()).toEqual({});
  });

  it("adopts a domain attached by hand, and leaves it attached when the move fails", async () => {
    const w = fakeWorld({ health: { kind: "down" } });
    w.world.domains.set("dom-hand", {
      hostname: HOST,
      service: WORKER,
      zone_id: "z-a",
      zone_name: "example.com",
    });
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "did not answer as this Appflare",
    );
    expect(w.world.domains.has("dom-hand")).toBe(true);
    expect(w.world.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);

    w.world.health = { kind: "serve", version: VERSION };
    const moved = await moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST });
    expect(moved.ok).toBe(true);
    expect(w.world.calls).not.toContain("PUT /workers/domains");
    expect(await setting(SETTING.managerDomainId)).toBe("dom-hand");
  });

  it("records passkeys against the address people used before an adoption", async () => {
    const w = fakeWorld();
    w.world.domains.set("dom-hand", {
      hostname: HOST,
      service: WORKER,
      zone_id: "z-a",
      zone_name: "example.com",
    });
    // The admins used the hand-attached domain: their passkeys belong to it.
    await env.DB.prepare("UPDATE settings SET value = ?1 WHERE key = 'notification_manager_url'")
      .bind(`https://${HOST}`)
      .run();
    await addPasskey("pk1");
    expect((await moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).ok).toBe(true);
    expect(await passkeyHosts()).toEqual([]);
    expect(await setting(SETTING.managerPreviousHostname)).toBeNull();
  });

  it("records passkeys against the Access hostname on a first move", async () => {
    const w = fakeWorld();
    await accessOn(w.world, "gate.example.com");
    await addPasskey("pk1");
    expect((await moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).ok).toBe(true);
    expect(await passkeyHosts()).toEqual([{ passkey_id: "pk1", hostname: "gate.example.com" }]);
    expect(await setting(SETTING.managerPreviousHostname)).toBe("gate.example.com");
  });

  it("keeps a domain that replaced DNS records attached when it never answers", async () => {
    const w = fakeWorld({
      health: { kind: "down" },
      records: { "z-a": [{ id: "r1", type: "A", name: HOST, content: "192.0.2.1" }] },
    });
    await expect(
      moveManagerAddress(deps(w), {
        zoneId: "z-a",
        hostname: HOST,
        overrideExistingDnsRecord: true,
      }),
    ).rejects.toThrow(
      `Appflare stays at ${WORKERS_DEV}. ${HOST} stays attached to Appflare so you can try again: the DNS records it replaced are gone, and Appflare cannot put them back.`,
    );
    expect(w.world.domains.has("dom-1")).toBe(true);
    expect(w.world.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    expect(await addressRows()).toEqual({});
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBe("appflare-replaced-records");

    // A later try without the override still never detaches it, and completes.
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "stays attached to Appflare so you can try again",
    );
    expect(w.world.domains.has("dom-1")).toBe(true);
    w.world.health = { kind: "serve", version: VERSION };
    expect((await moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).ok).toBe(true);
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBeNull();
  });

  it("detaches on a later try a domain it attached but could not detach", async () => {
    const w = fakeWorld({
      health: { kind: "down" },
      refuse: new Map([["DELETE /workers/domains/dom-1", 500]]),
    });
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      `Appflare could not remove ${HOST} again; it stays attached, and trying again uses it.`,
    );
    expect(w.world.domains.has("dom-1")).toBe(true);
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBe("appflare");

    // The domain now serves the manager, but Appflare attached it: not adopted.
    w.world.refuse.clear();
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "Appflare removed the domain again.",
    );
    expect(w.world.domains.size).toBe(0);
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBeNull();
  });

  it("moves Access back and detaches when the switch cannot be written", async () => {
    const w = fakeWorld();
    await accessOn(w.world, WORKERS_DEV);
    let failBatch = true;
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (failBatch) {
              failBatch = false;
              throw new Error("D1 batch failed");
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      moveManagerAddress({ ...deps(w), db }, { zoneId: "z-a", hostname: HOST }),
    ).rejects.toThrow("D1 batch failed");
    expect(w.world.apps.map((a) => a.domain)).toEqual([WORKERS_DEV, `${WORKERS_DEV}/api/health`]);
    expect(w.world.calls.filter((c) => c.startsWith("PUT /access/apps/"))).toEqual([
      "PUT /access/apps/app-main",
      "PUT /access/apps/app-health",
      "PUT /access/apps/app-main",
      "PUT /access/apps/app-health",
    ]);
    expect(w.world.domains.size).toBe(0);
    expect(await addressRows()).toEqual({});
    expect(await setting(SETTING.accessDomain)).toBe(WORKERS_DEV);
  });

  it("moves both Access applications and the protected hostname along when Access is on", async () => {
    const w = fakeWorld();
    await accessOn(w.world, WORKERS_DEV);
    expect((await moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).ok).toBe(true);
    const puts = w.world.bodies.filter((b) => b.key.startsWith("PUT /access/apps/"));
    expect(puts).toEqual([
      {
        key: "PUT /access/apps/app-main",
        body: {
          type: "self_hosted",
          name: `Appflare (${HOST})`,
          domain: HOST,
          session_duration: "24h",
          app_launcher_visible: false,
        },
      },
      {
        key: "PUT /access/apps/app-health",
        body: {
          type: "self_hosted",
          name: `Appflare health check (${HOST})`,
          domain: `${HOST}/api/health`,
          app_launcher_visible: false,
        },
      },
    ]);
    expect(await setting(SETTING.accessDomain)).toBe(HOST);
    expect(await setting(SETTING.accessAud)).toBe("aud-1");
    expect(await setting(SETTING.accessPolicyId)).toBe("pol-1");
    // Nothing moves before the hostname is checked and attached.
    expect(w.world.calls.indexOf("PUT /workers/domains")).toBeLessThan(
      w.world.calls.indexOf("PUT /access/apps/app-main"),
    );
  });

  it("makes an Access policy again when an application answers without one", async () => {
    const w = fakeWorld({ dropPolicies: true });
    await accessOn(w.world, WORKERS_DEV);
    expect((await moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).ok).toBe(true);
    const posts = w.world.bodies.filter((b) => b.key.includes("/policies"));
    expect(posts.map((p) => p.key)).toEqual([
      "POST /access/apps/app-main/policies",
      "POST /access/apps/app-health/policies",
    ]);
    expect(posts[0]?.body).toMatchObject({
      decision: "allow",
      include: [{ email: { email: "ada@example.com" } }],
    });
    expect(await setting(SETTING.accessPolicyId)).not.toBe("pol-1");
  });

  it("refuses before attaching anything when the token cannot manage Access", async () => {
    const w = fakeWorld({ refuse: new Map([["GET /access/apps", 403]]) });
    await accessOn(w.world, WORKERS_DEV);
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "The Cloudflare token cannot manage Access applications.",
    );
    expect(w.world.calls).not.toContain("PUT /workers/domains");
  });

  it("refuses a hostname another Access application protects", async () => {
    const w = fakeWorld();
    await accessOn(w.world, WORKERS_DEV);
    w.world.apps.push({ id: "other", aud: "x", name: "Wiki", domain: HOST, policies: [] });
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      'An Access application for this hostname already exists ("Wiki")',
    );
  });

  it("refuses a hostname that serves an installed app, naming the app", async () => {
    const w = fakeWorld();
    w.world.domains.set("dom-app", {
      hostname: HOST,
      service: "wiki",
      zone_id: "z-a",
      zone_name: "example.com",
    });
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, display_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('i1', 'wiki', 'wiki', 'Team wiki', '1', 'u', 'installed', 1, 1)`,
    ).run();
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      `${HOST} already serves the app Team wiki.`,
    );
  });

  it("refuses a hostname that serves another Worker", async () => {
    const w = fakeWorld();
    w.world.domains.set("dom-x", {
      hostname: HOST,
      service: "blog",
      zone_id: "z-a",
      zone_name: "example.com",
    });
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      `${HOST} already serves the Worker "blog".`,
    );
  });

  it("refuses the gateway's hostname, a hostname outside the zone, and a second move", async () => {
    const w = fakeWorld();
    await expect(
      moveManagerAddress(deps(w), { zoneId: "z-a", hostname: "appflare-gateway.example.com" }),
    ).rejects.toThrow("external domains gateway");
    await expect(
      moveManagerAddress(deps(w), { zoneId: "z-a", hostname: "appflare.other.org" }),
    ).rejects.toThrow("The hostname must be example.com or end in .example.com.");
    await movedTo(w.world, "old.example.com");
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "Appflare already lives at old.example.com. Use Change",
    );
  });
});

describe("changeManagerAddress", () => {
  it("moves to the new hostname, then detaches the old one", async () => {
    const w = fakeWorld();
    await movedTo(w.world, "old.example.com");
    await addPasskey("pk-dev");
    await addPasskey("pk-old");
    await addPasskey("pk-new");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO passkey_host (passkey_id, hostname, recorded_at) VALUES ('pk-dev', ?1, 1)",
      ).bind(WORKERS_DEV),
      env.DB.prepare(
        "INSERT INTO passkey_host (passkey_id, hostname, recorded_at) VALUES ('pk-new', ?1, 1)",
      ).bind(HOST),
    ]);
    const result = await changeManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST });
    expect(result).toMatchObject({ ok: true, hostname: HOST, previousDomain: "detached" });
    expect(w.world.calls.at(-1)).toBe("DELETE /workers/domains/dom-0");
    expect(await addressRows()).toMatchObject({
      manager_hostname: HOST,
      manager_previous_hostname: "old.example.com",
    });
    // Passkeys keep the address they were added at; those added at the new one work again.
    expect(await passkeyHosts()).toEqual([
      { passkey_id: "pk-dev", hostname: WORKERS_DEV },
      { passkey_id: "pk-old", hostname: "old.example.com" },
    ]);
  });

  it("refuses without an address to change, and the same address", async () => {
    const w = fakeWorld();
    await expect(changeManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "Appflare lives at its workers.dev address.",
    );
    await movedTo(w.world, HOST);
    await expect(changeManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      `Appflare already lives at ${HOST}.`,
    );
  });
});

describe("revertManagerAddress", () => {
  it("moves Access back, clears the rows, then detaches the domain", async () => {
    const w = fakeWorld();
    await movedTo(w.world, HOST);
    await accessOn(w.world, HOST);
    await addPasskey("pk-dev");
    await addPasskey("pk-host");
    await env.DB.prepare(
      "INSERT INTO passkey_host (passkey_id, hostname, recorded_at) VALUES ('pk-dev', ?1, 1)",
    )
      .bind(WORKERS_DEV)
      .run();
    const result = await revertManagerAddress(deps(w), {});
    expect(result).toEqual({
      wasMoved: true,
      url: `https://${WORKERS_DEV}/login?returnTo=%2Fsettings%2Fdomains%23address&moved=1`,
      previousDomain: "detached",
    });
    expect(w.world.calls).toEqual([
      "PUT /access/apps/app-main",
      "PUT /access/apps/app-health",
      "DELETE /workers/domains/dom-0",
    ]);
    expect(w.world.apps.map((a) => a.domain)).toEqual([WORKERS_DEV, `${WORKERS_DEV}/api/health`]);
    expect(await setting(SETTING.accessDomain)).toBe(WORKERS_DEV);
    expect(await addressRows()).toEqual({});
    expect(await passkeyHosts()).toEqual([{ passkey_id: "pk-host", hostname: HOST }]);
  });

  it("changes nothing when Access cannot be moved back", async () => {
    const w = fakeWorld({ refuse: new Map([["PUT /access/apps/app-main", 403]]) });
    await movedTo(w.world, HOST);
    await accessOn(w.world, HOST);
    await expect(revertManagerAddress(deps(w), {})).rejects.toThrow(
      "The Cloudflare token cannot manage Access applications.",
    );
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
    expect(w.world.domains.has("dom-0")).toBe(true);
  });

  it("puts the first Access application back when the second cannot move", async () => {
    const w = fakeWorld({ refuse: new Map([["PUT /access/apps/app-health", 500]]) });
    await movedTo(w.world, HOST);
    await accessOn(w.world, HOST);
    await expect(revertManagerAddress(deps(w), {})).rejects.toThrow();
    expect(w.world.apps.map((a) => a.domain)).toEqual([HOST, `${HOST}/api/health`]);
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
  });

  it("does nothing at workers.dev", async () => {
    const w = fakeWorld();
    expect(await revertManagerAddress(deps(w), {})).toEqual({
      wasMoved: false,
      url: null,
      previousDomain: null,
    });
    expect(w.world.calls).toEqual([]);
  });
});

describe("reconcileManagerAddress", () => {
  const lazy = (w: ReturnType<typeof fakeWorld>, made: { count: number }) => ({
    db: env.DB,
    now: () => NOW,
    api: async () => {
      made.count++;
      return w.api;
    },
  });

  it("makes no call at workers.dev", async () => {
    const made = { count: 0 };
    expect(await reconcileManagerAddress(lazy(fakeWorld(), made))).toEqual({
      status: "workers-dev",
    });
    expect(made.count).toBe(0);
  });

  it("leaves a domain that still serves the manager alone", async () => {
    const w = fakeWorld();
    await movedTo(w.world, HOST);
    expect(await reconcileManagerAddress(lazy(w, { count: 0 }))).toEqual({
      status: "serving",
      hostname: HOST,
    });
    expect(w.world.calls).toEqual([`GET /workers/domains?service=${WORKER}`]);
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
  });

  it("goes back to workers.dev and notifies when the domain is gone", async () => {
    const w = fakeWorld();
    await movedTo(w.world, HOST);
    await accessOn(w.world, HOST);
    w.world.domains.delete("dom-0");
    await env.DB.prepare(
      `INSERT INTO notification_channels (id, kind, label, target, config, events_json, created_at, updated_at)
       VALUES ('c1', 'webhook', 'Ops', 'example.org', 'v1.x.y', '["manager_address_lost"]', 0, 0)`,
    ).run();
    expect(await reconcileManagerAddress(lazy(w, { count: 0 }))).toEqual({
      status: "lost",
      hostname: HOST,
      notified: 1,
    });
    expect(await addressRows()).toEqual({});
    expect(await setting(SETTING.accessDomain)).toBe(WORKERS_DEV);
    const event = await env.DB.prepare(
      "SELECT type, dedupe_key, facts_json FROM notification_events",
    ).first();
    expect(event).toEqual({
      type: "manager_address_lost",
      dedupe_key: `manager_address_lost:${HOST}:2026-09-01T00:00:00.000Z`,
      facts_json: JSON.stringify({ type: "manager_address_lost", hostname: HOST }),
    });
  });

  it("clears the address even when Access cannot follow", async () => {
    const w = fakeWorld({ refuse: new Map([["PUT /access/apps/app-main", 403]]) });
    await movedTo(w.world, HOST);
    await accessOn(w.world, HOST);
    w.world.domains.delete("dom-0");
    await env.DB.prepare(
      `INSERT INTO notification_channels (id, kind, label, target, config, events_json, created_at, updated_at)
       VALUES ('c1', 'webhook', 'Ops', 'example.org', 'v1.x.y', '["manager_address_lost"]', 0, 0)`,
    ).run();
    expect((await reconcileManagerAddress(lazy(w, { count: 0 }))).status).toBe("lost");
    expect(await addressRows()).toEqual({});
    expect(await setting(SETTING.accessDomain)).toBe(HOST);
    // The message says that sign-in at workers.dev is refused until Access is recovered.
    const event = await env.DB.prepare("SELECT facts_json FROM notification_events").first<{
      facts_json: string;
    }>();
    expect(JSON.parse(event?.facts_json ?? "{}")).toEqual({
      type: "manager_address_lost",
      hostname: HOST,
      accessLeftBehind: true,
    });
  });

  it("changes nothing when Cloudflare's list of domains cannot be read", async () => {
    const w = fakeWorld({ refuse: new Map([["GET /workers/domains", 500]]) });
    await movedTo(w.world, HOST);
    await expect(reconcileManagerAddress(lazy(w, { count: 0 }))).rejects.toThrow();
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
    expect(await setting(SETTING.managerDomainId)).toBe("dom-0");
  });
});

describe("readManagerAddress", () => {
  it("reports the address, whether it serves, and domains attached by hand", async () => {
    const w = fakeWorld();
    await movedTo(w.world, HOST);
    w.world.domains.set("dom-hand", {
      hostname: "manage.beta.dev",
      service: WORKER,
      zone_id: "z-b",
      zone_name: "beta.dev",
    });
    expect(await readManagerAddress(deps(w))).toEqual({
      hostname: HOST,
      zoneId: "z-a",
      previousHostname: WORKERS_DEV,
      movedAt: "2026-09-01T00:00:00.000Z",
      workersDevHostname: WORKERS_DEV,
      serving: true,
      attachedByHand: [{ hostname: "manage.beta.dev", zoneId: "z-b", zoneName: "beta.dev" }],
    });
    w.world.domains.delete("dom-0");
    expect((await readManagerAddress(deps(w))).serving).toBe(false);
  });
});

describe("listAddressOptions", () => {
  it("suggests appflare.<zone> for every active zone", async () => {
    const w = fakeWorld();
    expect((await listAddressOptions(deps(w))).zones).toEqual([
      { id: "z-b", name: "beta.dev", suggestedHostname: "appflare.beta.dev" },
      { id: "z-a", name: "example.com", suggestedHostname: "appflare.example.com" },
    ]);
  });
});

describe("waitForManager", () => {
  it("answers at once when the first probe reports this version", async () => {
    const w = fakeWorld();
    w.world.domains.set("d", { hostname: HOST, service: WORKER, zone_id: "z-a", zone_name: "x" });
    const d = deps(w);
    expect(await waitForManager(d, HOST)).toEqual({ ok: true });
    expect(d.slept).toEqual([]);
  });
});
