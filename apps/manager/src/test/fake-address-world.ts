import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { writeAccessConfig } from "../access/config";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import type { ManagerAddressDeps } from "../domains/manager-address.server";
import type { MoveAddressJobParams } from "../domains/move-address-job";
import { ACC, TOKEN } from "./fake-account";

/**
 * Test-only world for Appflare's address: the local D1 and a stateful fake
 * of the zones, DNS records, Workers custom domains and Access applications
 * API, with the new hostname's health endpoint answered from what is
 * attached.
 */

export const NOW = new Date("2026-09-28T12:00:00.000Z");
export const VERSION = "1.4.0";
export const WORKER = "appflare";
export const WORKERS_DEV = "appflare.ada.workers.dev";
export const HOST = "appflare.example.com";

export interface Domain {
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
}

export interface AccessAppRow {
  id: string;
  aud: string;
  name: string;
  domain: string;
  policies: Array<{ id: string }>;
}

export interface World {
  domains: Map<string, Domain>;
  records: Record<string, Array<{ id: string; type: string; name: string; content: string }>>;
  apps: AccessAppRow[];
  /** `METHOD /path` answered with this status and code 10000. */
  refuse: Map<string, number>;
  /** How the health endpoint answers: `serve` answers as the manager whose version is given. */
  health: { kind: "serve"; version: string } | { kind: "down" } | { kind: "edge-1042" };
  /**
   * The certificate is still being issued: this many probes fail with a
   * TLS error (Cloudflare's 526) before `health` answers.
   */
  certificateAfter: number;
  /** PUT /access/apps answers with no policies (a policy must be made again). */
  dropPolicies: boolean;
  calls: string[];
  bodies: Array<{ key: string; body: unknown }>;
  probes: string[];
}

export function fakeWorld(over: Partial<World> = {}) {
  const world: World = {
    domains: new Map(),
    records: {},
    apps: [],
    refuse: new Map(),
    health: { kind: "serve", version: VERSION },
    certificateAfter: 0,
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
    if (world.probes.length <= world.certificateAfter) {
      return new Response("error code: 526", { status: 526 });
    }
    if (world.health.kind === "edge-1042") {
      return new Response("error code: 1042", { status: 404 });
    }
    return Response.json({ version: world.health.version, db: "ok" });
  };

  const client = createClient({ accountId: ACC, token: TOKEN, fetch: api });
  /** Cloudflare's API and the new hostname, as a job's one `fetch` sees them. */
  const anyFetch = async (input: string, init?: RequestInit): Promise<Response> =>
    new URL(input).hostname === "api.cloudflare.com" ? api(input, init) : fetch(input);
  return { world, api: client, fetch, anyFetch };
}

/** The request's dependencies; `started` collects the jobs it starts. */
export function deps(
  w: ReturnType<typeof fakeWorld>,
): ManagerAddressDeps & { started: MoveAddressJobParams[] } {
  const started: MoveAddressJobParams[] = [];
  let n = 0;
  return {
    db: env.DB,
    api: w.api,
    version: VERSION,
    now: () => NOW,
    newId: () => `01MOVEJOB${String(++n).padStart(17, "0")}`,
    createJob: async (id, params) => {
      started.push(params);
      return { id: `instance-${id}` };
    },
    started,
  };
}

export async function setting(key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function addressRows() {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key LIKE 'manager_%' AND key <> 'manager_version_history'
     AND key NOT LIKE 'manager_domain_attached_by:%' ORDER BY key`,
  ).all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function passkeyHosts() {
  const { results } = await env.DB.prepare(
    "SELECT passkey_id, hostname FROM passkey_host ORDER BY passkey_id",
  ).all();
  return results;
}

export async function addPasskey(id: string) {
  await env.DB.prepare(
    `INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
     VALUES (?1, 'k', 'u1', ?1, 0, 'singleDevice', 0)`,
  )
    .bind(id)
    .run();
}

/** Access on for `domain`, with its two applications in the fake account. */
export async function accessOn(world: World, domain: string) {
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
export async function movedTo(world: World, hostname: string) {
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

/** A fresh database with the manager's Worker known, one admin, and a remembered manager URL. */
export async function seedAddressWorld(): Promise<void> {
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
}
