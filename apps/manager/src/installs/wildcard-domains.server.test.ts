import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { ACC, TOKEN } from "../test/fake-account";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { addCustomDomainCore, CustomDomainError } from "./custom-domains.server";
import { addExternalDomainCore, ExternalDomainError } from "./external-domains.server";
import { WILDCARD_EXTERNAL_REFUSAL } from "./wildcard-domain-input";
import {
  addWildcardDomainCore,
  attachWildcardDomain,
  detachWildcardParts,
  removeWildcardDomainCore,
  WildcardDomainError,
  WildcardDomainTransientError,
  wildcardRecordComment,
} from "./wildcard-domains.server";

/**
 * Wildcard domains against the local D1 and a stateful fake of the zones,
 * DNS records, Workers routes, and Workers custom domains API.
 */

const NOW = new Date("2026-09-27T12:00:00.000Z");
const REASON = "Each tunnel gets its own address under this hostname.";
const WILDCARD_MANIFEST = JSON.stringify({
  version: "1.0.0",
  worker: { migrations: [] },
  catalog: { slug: "hostc", install: { wildcardHostname: true, wildcardReason: REASON } },
});

interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
}

interface World {
  zones: Array<{ id: string; name: string; status: string; account: { id: string } }>;
  records: Record<string, FakeRecord[]>;
  routes: Record<string, Array<{ id: string; pattern: string; script?: string }>>;
  domains: Array<{ id: string; hostname: string; service: string; zone_id: string }>;
  /** `METHOD /path` keys (path pattern with ids) answered 403 code 10000. */
  refuse: Set<string>;
  calls: string[];
  subdomain: unknown[];
  /** Runs before a route is created (to change the database meanwhile). */
  onRoute?: () => Promise<void>;
  /** The `METHOD /path` call that fails once `after` of them succeeded, with this error. */
  failAt?: { key: string; after: number; status: number; code: number; message: string };
  /** The `METHOD /path` call whose first request is carried out, then answered with a 502. */
  loseAnswer?: string;
  /** `METHOD /path:id` shapes whose calls fail with a 500 (after `refuse`). */
  broken?: Set<string>;
}

function fakeApi(over: Partial<World> = {}) {
  let n = 0;
  const world: World = {
    zones: [{ id: "z-a", name: "example.com", status: "active", account: { id: ACC } }],
    records: {},
    routes: {},
    domains: [],
    refuse: new Set(),
    calls: [],
    subdomain: [],
    ...over,
  };
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, code: number, message: string) =>
    Response.json({ success: false, errors: [{ code, message }], messages: [] }, { status });

  let answerLost = false;
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const response = await handle(input, init);
    const key = world.calls.at(-1);
    if (!answerLost && key !== undefined && key === world.loseAnswer) {
      answerLost = true;
      return fail(502, 0, "Bad gateway");
    }
    return response;
  };
  const handle = async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace("/client/v4", "").replace(`/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    world.calls.push(key);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return fail(403, 10000, "auth");
    const shape = key.replace(/\/(dns_records|routes)\/[^/]+$/, "/$1/:id");
    if (world.refuse.has(shape)) return fail(403, 10000, "Authentication error");
    if (world.broken?.has(shape)) return fail(500, 10013, "internal error");
    const failAt = world.failAt;
    if (failAt?.key === key && world.calls.filter((c) => c === key).length > failAt.after) {
      return fail(failAt.status, failAt.code, failAt.message);
    }
    let m = /^GET \/zones\/([^/]+)$/.exec(key);
    if (m?.[1]) {
      const zone = world.zones.find((z) => z.id === m?.[1]);
      return zone === undefined ? fail(404, 1001, "Invalid zone") : ok(zone);
    }
    m = /^(GET|POST) \/zones\/([^/]+)\/dns_records$/.exec(key);
    if (m?.[2]) {
      world.records[m[2]] = world.records[m[2]] ?? [];
      const list = world.records[m[2]] ?? [];
      if (m[1] === "GET") {
        const name = url.searchParams.get("name.exact");
        const suffix = url.searchParams.get("name.endswith");
        return ok(
          list.filter((r) => (suffix === null ? r.name === name : r.name.endsWith(suffix))),
          { result_info: { page: 1, total_pages: 1 } },
        );
      }
      const body = (await request.json()) as Omit<FakeRecord, "id">;
      const record = { id: `rec-${++n}`, ...body };
      list.push(record);
      return ok(record);
    }
    m = /^DELETE \/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(key);
    if (m?.[1] && m[2]) {
      const list = world.records[m[1]] ?? [];
      const i = list.findIndex((r) => r.id === m?.[2]);
      if (i < 0) return fail(404, 81044, "Record does not exist.");
      list.splice(i, 1);
      return ok({ id: m[2] });
    }
    m = /^(GET|POST) \/zones\/([^/]+)\/workers\/routes$/.exec(key);
    if (m?.[2]) {
      world.routes[m[2]] = world.routes[m[2]] ?? [];
      const list = world.routes[m[2]] ?? [];
      if (m[1] === "GET") return ok(list);
      await world.onRoute?.();
      const body = (await request.json()) as { pattern: string; script?: string };
      const route = { id: `route-${++n}`, ...body };
      list.push(route);
      return ok(route);
    }
    m = /^DELETE \/zones\/([^/]+)\/workers\/routes\/([^/]+)$/.exec(key);
    if (m?.[1] && m[2]) {
      const list = world.routes[m[1]] ?? [];
      const i = list.findIndex((r) => r.id === m?.[2]);
      if (i < 0) return fail(404, 10020, "route not found");
      list.splice(i, 1);
      return ok({ id: m[2] });
    }
    if (key === "GET /workers/domains") {
      const hostname = url.searchParams.get("hostname");
      const zoneId = url.searchParams.get("zone_id");
      return ok(
        world.domains.filter(
          (d) =>
            (hostname === null || d.hostname === hostname) &&
            (zoneId === null || d.zone_id === zoneId),
        ),
      );
    }
    m = /^POST \/workers\/scripts\/([^/]+)\/subdomain$/.exec(key);
    if (m?.[1]) {
      const body = (await request.json()) as object;
      world.subdomain.push({ script: m[1], ...body });
      return ok(body);
    }
    return fail(404, 7003, `no route ${key}`);
  };
  const api = createClient({ accountId: ACC, token: TOKEN, fetch });
  return { world, api };
}

function deps(api: ReturnType<typeof fakeApi>["api"]) {
  let n = 0;
  return { db: env.DB, api, now: () => NOW, newId: () => `id${++n}` };
}

async function rows() {
  return (
    await env.DB.prepare(
      "SELECT id, kind, binding, name, cf_id, deleted_at FROM resources WHERE install_id = ?1 ORDER BY rowid",
    )
      .bind(INSTALL_ID)
      .all()
  ).results;
}

const zoneA = { id: "z-a", name: "example.com", status: "active", account: { id: ACC } };

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall({ manifestJson: WILDCARD_MANIFEST });
});

describe("attachWildcardDomain", () => {
  it("creates proxied records for the base and every name under it, then both routes", async () => {
    const { world, api } = fakeApi();
    const attached = await attachWildcardDomain(api, {
      zone: zoneA,
      hostname: "tunnels.example.com",
      workerName: "cut",
    });
    expect(attached.parts.map((p) => [p.kind, p.name, p.created])).toEqual([
      ["dns_record", "tunnels.example.com", true],
      ["dns_record", "*.tunnels.example.com", true],
      ["worker_route", "tunnels.example.com/*", true],
      ["worker_route", "*.tunnels.example.com/*", true],
    ]);
    expect(world.records["z-a"]).toEqual([
      expect.objectContaining({
        type: "AAAA",
        name: "tunnels.example.com",
        content: "100::",
        proxied: true,
        comment: wildcardRecordComment("cut"),
      }),
      expect.objectContaining({ name: "*.tunnels.example.com", proxied: true }),
    ]);
    expect(world.routes["z-a"]?.map((r) => [r.pattern, r.script])).toEqual([
      ["tunnels.example.com/*", "cut"],
      ["*.tunnels.example.com/*", "cut"],
    ]);
  });

  it("takes over what an earlier attempt created instead of creating it twice", async () => {
    const { world, api } = fakeApi({
      records: {
        "z-a": [
          {
            id: "rec-old",
            type: "AAAA",
            name: "tunnels.example.com",
            content: "100::",
            comment: wildcardRecordComment("cut"),
          },
        ],
      },
      routes: { "z-a": [{ id: "route-old", pattern: "tunnels.example.com/*", script: "cut" }] },
    });
    const attached = await attachWildcardDomain(api, {
      zone: zoneA,
      hostname: "tunnels.example.com",
      workerName: "cut",
    });
    // The route sat beside a missing record, so an admin made it: used, not Appflare's.
    expect(attached.parts.map((p) => [p.id, p.created, p.owned])).toEqual([
      ["rec-old", false, true],
      [expect.stringMatching(/^rec-/), true, true],
      ["route-old", false, false],
      [expect.stringMatching(/^route-/), true, true],
    ]);
    expect(world.records["z-a"]).toHaveLength(2);
    expect(world.routes["z-a"]).toHaveLength(2);
  });

  it("takes a route beside both of its own records as an earlier attempt's", async () => {
    const comment = wildcardRecordComment("cut");
    const { api } = fakeApi({
      records: {
        "z-a": [
          { id: "rec-1", type: "AAAA", name: "t.example.com", content: "100::", comment },
          { id: "rec-2", type: "AAAA", name: "*.t.example.com", content: "100::", comment },
        ],
      },
      routes: { "z-a": [{ id: "route-old", pattern: "t.example.com/*", script: "cut" }] },
    });
    const attached = await attachWildcardDomain(api, {
      zone: zoneA,
      hostname: "t.example.com",
      workerName: "cut",
    });
    expect(attached.parts.map((p) => [p.id, p.created, p.owned])).toEqual([
      ["rec-1", false, true],
      ["rec-2", false, true],
      ["route-old", false, true],
      [expect.stringMatching(/^route-/), true, true],
    ]);
  });

  it("refuses names that already serve something through the proxy under the base", async () => {
    const { world, api } = fakeApi({
      records: {
        "z-a": [
          {
            id: "r1",
            type: "A",
            name: "api.tunnels.example.com",
            content: "192.0.2.1",
            proxied: true,
          },
          {
            id: "r2",
            type: "CNAME",
            name: "a.b.tunnels.example.com",
            content: "x.io",
            proxied: true,
          },
          // DNS only: a Worker route never sees it.
          { id: "r3", type: "A", name: "mail.tunnels.example.com", content: "192.0.2.2" },
          { id: "r4", type: "A", name: "api.example.com", content: "192.0.2.3", proxied: true },
        ],
      },
    });
    const refused = attachWildcardDomain(api, {
      zone: zoneA,
      hostname: "tunnels.example.com",
      workerName: "cut",
    });
    await expect(refused).rejects.toBeInstanceOf(WildcardDomainError);
    await expect(refused).rejects.toThrow(
      /^a\.b\.tunnels\.example\.com and api\.tunnels\.example\.com already serve something through Cloudflare, and this app answers on every name under tunnels\.example\.com/,
    );
    expect(world.calls).toContain("GET /zones/z-a/dns_records");
    expect(world.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("does not count names a more specific route already takes", async () => {
    const { world, api } = fakeApi({
      records: {
        "z-a": [
          {
            id: "r1",
            type: "A",
            name: "api.apps.example.com",
            content: "192.0.2.1",
            proxied: true,
          },
          {
            id: "r2",
            type: "A",
            name: "x.b.apps.example.com",
            content: "192.0.2.2",
            proxied: true,
          },
        ],
      },
      routes: {
        "z-a": [
          { id: "route-api", pattern: "api.apps.example.com/*", script: "api-worker" },
          // A wildcard nearer to the name wins over *.apps.example.com/*.
          { id: "route-b", pattern: "*.b.apps.example.com/*" },
        ],
      },
    });
    await attachWildcardDomain(api, {
      zone: zoneA,
      hostname: "apps.example.com",
      workerName: "cut",
    });
    expect(world.routes["z-a"]).toHaveLength(4);
  });

  it("still counts a name whose route takes only some of its paths", async () => {
    const { api } = fakeApi({
      records: {
        "z-a": [
          {
            id: "r1",
            type: "A",
            name: "api.apps.example.com",
            content: "192.0.2.1",
            proxied: true,
          },
        ],
      },
      routes: { "z-a": [{ id: "x", pattern: "api.apps.example.com/v1/*", script: "api" }] },
    });
    await expect(
      attachWildcardDomain(api, { zone: zoneA, hostname: "apps.example.com", workerName: "cut" }),
    ).rejects.toThrow(/^api\.apps\.example\.com already serves something through Cloudflare/);
  });

  it("does not count another app's custom domain under the base, whose record is in the DNS list", async () => {
    // A Workers custom domain's record is listed as a proxied AAAA (seen live);
    // the custom domain answers its name before any route runs.
    const { world, api } = fakeApi({
      records: {
        "z-a": [
          {
            id: "r1",
            type: "AAAA",
            name: "app1.apps.example.com",
            content: "100::",
            proxied: true,
          },
        ],
      },
      domains: [{ id: "d1", hostname: "app1.apps.example.com", service: "app1", zone_id: "z-a" }],
    });
    await attachWildcardDomain(api, {
      zone: zoneA,
      hostname: "apps.example.com",
      workerName: "app2",
    });
    expect(world.routes["z-a"]?.map((r) => r.pattern)).toEqual([
      "apps.example.com/*",
      "*.apps.example.com/*",
    ]);
  });

  it("serves names that exist under a whole zone the admin agreed to serve", async () => {
    const { world, api } = fakeApi({
      records: {
        "z-a": [
          { id: "r1", type: "A", name: "blog.example.com", content: "192.0.2.1", proxied: true },
        ],
      },
    });
    await attachWildcardDomain(api, {
      zone: zoneA,
      hostname: "example.com",
      workerName: "cut",
      wholeDomain: true,
    });
    expect(world.routes["z-a"]?.map((r) => r.pattern)).toEqual([
      "example.com/*",
      "*.example.com/*",
    ]);
  });

  it("removes what it created when a later create fails, and says so", async () => {
    const { world, api } = fakeApi({
      failAt: {
        key: "POST /zones/z-a/workers/routes",
        after: 1,
        status: 400,
        code: 10020,
        message: "A route with the same pattern already exists",
      },
    });
    const failed = attachWildcardDomain(api, {
      zone: zoneA,
      hostname: "tunnels.example.com",
      workerName: "cut",
    });
    await expect(failed).rejects.toBeInstanceOf(WildcardDomainError);
    await expect(failed).rejects.toThrow(
      /Cloudflare could not set up \*\.tunnels\.example\.com \(.*same pattern.*\)\. Appflare removed what it had already created for it \(tunnels\.example\.com\/\*, tunnels\.example\.com and \*\.tunnels\.example\.com\), so the domain is as it was\./,
    );
    expect(world.records["z-a"]).toEqual([]);
    expect(world.routes["z-a"]).toEqual([]);
  });

  it("keeps what it found when a create fails, removing only what it created", async () => {
    const comment = wildcardRecordComment("cut");
    const { world, api } = fakeApi({
      records: {
        "z-a": [{ id: "rec-old", type: "AAAA", name: "t.example.com", content: "100::", comment }],
      },
      failAt: {
        key: "POST /zones/z-a/workers/routes",
        after: 0,
        status: 500,
        code: 10013,
        message: "internal error",
      },
    });
    await expect(
      attachWildcardDomain(api, { zone: zoneA, hostname: "t.example.com", workerName: "cut" }),
    ).rejects.toThrow(/removed what it had already created for it \(\*\.t\.example\.com\)/);
    expect(world.records["z-a"]?.map((r) => r.id)).toEqual(["rec-old"]);
  });

  it("leaves a failure that may pass retryable once the zone is as it was", async () => {
    const { world, api } = fakeApi({
      failAt: {
        key: "POST /zones/z-a/workers/routes",
        after: 1,
        status: 503,
        code: 10013,
        message: "service unavailable",
      },
    });
    const failed = attachWildcardDomain(api, {
      zone: zoneA,
      hostname: "t.example.com",
      workerName: "cut",
    });
    // Not a WildcardDomainError, which the install job's step would treat as final.
    await expect(failed).rejects.toBeInstanceOf(WildcardDomainTransientError);
    await expect(failed).rejects.not.toBeInstanceOf(WildcardDomainError);
    await expect(failed).rejects.toThrow(
      /Cloudflare could not set up \*\.t\.example\.com \(.*service unavailable.*\)\. Appflare removed what it had already created for it \(t\.example\.com\/\*, t\.example\.com and \*\.t\.example\.com\)/,
    );
    expect(world.records["z-a"]).toEqual([]);
    expect(world.routes["z-a"]).toEqual([]);
  });

  it("removes the second record's partner when the second record cannot be created", async () => {
    const { world, api } = fakeApi({
      failAt: {
        key: "POST /zones/z-a/dns_records",
        after: 1,
        status: 500,
        code: 10013,
        message: "internal error",
      },
    });
    await expect(
      attachWildcardDomain(api, { zone: zoneA, hostname: "t.example.com", workerName: "cut" }),
    ).rejects.toThrow(
      /removed what it had already created for it \(t\.example\.com\), so the domain/,
    );
    expect(world.records["z-a"]).toEqual([]);
    expect(world.calls.some((c) => c === "POST /zones/z-a/workers/routes")).toBe(false);
  });

  it("finds and removes a route whose create answer was lost", async () => {
    const { world, api } = fakeApi({ loseAnswer: "POST /zones/z-a/workers/routes" });
    await expect(
      attachWildcardDomain(api, { zone: zoneA, hostname: "t.example.com", workerName: "cut" }),
    ).rejects.toBeInstanceOf(WildcardDomainTransientError);
    // The route was made although its answer never came back; it is gone again.
    expect(world.routes["z-a"]).toEqual([]);
    expect(world.records["z-a"]).toEqual([]);
  });

  it("names only what is left when some removals fail", async () => {
    const { world, api } = fakeApi({
      failAt: {
        key: "POST /zones/z-a/workers/routes",
        after: 1,
        status: 500,
        code: 10013,
        message: "internal error",
      },
      broken: new Set(["DELETE /zones/z-a/workers/routes/:id"]),
    });
    const failed = attachWildcardDomain(api, {
      zone: zoneA,
      hostname: "t.example.com",
      workerName: "cut",
    });
    await expect(failed).rejects.toBeInstanceOf(WildcardDomainError);
    await expect(failed).rejects.toThrow(
      /Appflare could not remove what it had created for it \(.*\): delete t\.example\.com\/\* in the Cloudflare dashboard/,
    );
    // It went on past the route and removed both records.
    expect(world.records["z-a"]).toEqual([]);
    expect(world.routes["z-a"]?.map((r) => r.pattern)).toEqual(["t.example.com/*"]);
  });

  it("names what is left when it cannot remove what it created", async () => {
    const { world, api } = fakeApi({
      failAt: {
        key: "POST /zones/z-a/workers/routes",
        after: 0,
        status: 500,
        code: 10013,
        message: "internal error",
      },
      refuse: new Set(["DELETE /zones/z-a/dns_records/:id"]),
    });
    await expect(
      attachWildcardDomain(api, { zone: zoneA, hostname: "t.example.com", workerName: "cut" }),
    ).rejects.toThrow(
      /could not remove what it had created for it \(.*\): delete t\.example\.com and \*\.t\.example\.com in the Cloudflare dashboard/,
    );
    expect(world.records["z-a"]).toHaveLength(2);
  });

  it("refuses address records it did not make, and creates nothing", async () => {
    const { world, api } = fakeApi({
      records: {
        "z-a": [
          { id: "r1", type: "CNAME", name: "*.tunnels.example.com", content: "elsewhere.io" },
        ],
      },
    });
    await expect(
      attachWildcardDomain(api, {
        zone: zoneA,
        hostname: "tunnels.example.com",
        workerName: "cut",
      }),
    ).rejects.toThrow(/\*\.tunnels\.example\.com already has DNS records \(CNAME elsewhere\.io\)/);
    expect(world.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
  });

  it("refuses a route of another Worker, and a custom domain at the base", async () => {
    const other = fakeApi({
      routes: { "z-a": [{ id: "x", pattern: "*.tunnels.example.com/*", script: "someone" }] },
    });
    await expect(
      attachWildcardDomain(other.api, {
        zone: zoneA,
        hostname: "tunnels.example.com",
        workerName: "cut",
      }),
    ).rejects.toThrow(/already sends requests to the Worker "someone"/);
    const domain = fakeApi({
      domains: [{ id: "d1", hostname: "tunnels.example.com", service: "blog", zone_id: "z-a" }],
    });
    await expect(
      attachWildcardDomain(domain.api, {
        zone: zoneA,
        hostname: "tunnels.example.com",
        workerName: "cut",
      }),
    ).rejects.toBeInstanceOf(WildcardDomainError);
    expect([...other.world.calls, ...domain.world.calls].some((c) => c.startsWith("POST"))).toBe(
      false,
    );
  });

  it("names the permission Cloudflare refused, and removes the records it created", async () => {
    const { world, api } = fakeApi({ refuse: new Set(["POST /zones/z-a/workers/routes"]) });
    await expect(
      attachWildcardDomain(api, {
        zone: zoneA,
        hostname: "tunnels.example.com",
        workerName: "cut",
      }),
    ).rejects.toThrow(
      /needs Workers Routes: Edit on example\.com\. Add it to the token and try again\. Appflare removed what it had already created/,
    );
    expect(world.records["z-a"]).toEqual([]);
  });
});

describe("addWildcardDomainCore", () => {
  it("records the wildcard domain with its records and routes", async () => {
    const { api } = fakeApi();
    const added = await addWildcardDomainCore(deps(api), {
      installId: INSTALL_ID,
      zoneId: "z-a",
      hostname: "Tunnels.example.com",
    });
    expect(added).toEqual({
      resourceId: `${INSTALL_ID}:wildcard_domain:id1`,
      hostname: "tunnels.example.com",
      settingsJobId: null,
      settingsNote: null,
    });
    expect(await rows()).toEqual([
      {
        id: `${INSTALL_ID}:wildcard_domain:id1`,
        kind: "wildcard_domain",
        binding: null,
        name: "tunnels.example.com",
        cf_id: "z-a",
        deleted_at: null,
      },
      expect.objectContaining({
        kind: "dns_record",
        binding: "tunnels.example.com",
        name: "tunnels.example.com",
        cf_id: expect.stringMatching(/^z-a\/rec-/),
      }),
      expect.objectContaining({ kind: "dns_record", name: "*.tunnels.example.com" }),
      expect.objectContaining({
        kind: "worker_route",
        binding: "tunnels.example.com",
        name: "tunnels.example.com/*",
        cf_id: expect.stringMatching(/^z-a\/route-/),
      }),
      expect.objectContaining({ kind: "worker_route", name: "*.tunnels.example.com/*" }),
    ]);
  });

  it("asks before using the whole zone, then serves every name in it", async () => {
    const { world, api } = fakeApi();
    await expect(
      addWildcardDomainCore(deps(api), {
        installId: INSTALL_ID,
        zoneId: "z-a",
        hostname: "example.com",
      }),
    ).rejects.toThrow(/example\.com is a whole domain/);
    expect(world.calls.some((c) => c.startsWith("POST"))).toBe(false);
    await addWildcardDomainCore(deps(api), {
      installId: INSTALL_ID,
      zoneId: "z-a",
      hostname: "example.com",
      wholeDomain: true,
    });
    expect(world.routes["z-a"]?.map((r) => r.pattern)).toEqual([
      "example.com/*",
      "*.example.com/*",
    ]);
  });

  it("allows one wildcard domain per app", async () => {
    const { api } = fakeApi();
    await addWildcardDomainCore(deps(api), {
      installId: INSTALL_ID,
      zoneId: "z-a",
      hostname: "tunnels.example.com",
    });
    await expect(
      addWildcardDomainCore(deps(api), {
        installId: INSTALL_ID,
        zoneId: "z-a",
        hostname: "t2.example.com",
      }),
    ).rejects.toThrow(/already answers on \*\.tunnels\.example\.com/);
  });

  it("refuses an app that answers on exact hostnames", async () => {
    await env.DB.prepare("UPDATE installs SET manifest_json = ?1 WHERE id = ?2")
      .bind(JSON.stringify({ version: "1.0.0", catalog: { install: {} } }), INSTALL_ID)
      .run();
    const { api } = fakeApi();
    await expect(
      addWildcardDomainCore(deps(api), {
        installId: INSTALL_ID,
        zoneId: "z-a",
        hostname: "t.example.com",
      }),
    ).rejects.toThrow(/add a custom domain instead/);
  });

  it("removes what it created when the app started uninstalling meanwhile", async () => {
    const { world, api } = fakeApi({
      onRoute: async () => {
        await env.DB.prepare("UPDATE installs SET status = 'uninstalling' WHERE id = ?1")
          .bind(INSTALL_ID)
          .run();
      },
    });
    await expect(
      addWildcardDomainCore(deps(api), {
        installId: INSTALL_ID,
        zoneId: "z-a",
        hostname: "t.example.com",
      }),
    ).rejects.toThrow(/removed its records and routes again/);
    expect(world.records["z-a"]).toEqual([]);
    expect(world.routes["z-a"]).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("records nothing and leaves the zone as it was when a create fails part way", async () => {
    const { world, api } = fakeApi({
      failAt: {
        key: "POST /zones/z-a/workers/routes",
        after: 1,
        status: 403,
        code: 10000,
        message: "Authentication error",
      },
    });
    await expect(
      addWildcardDomainCore(deps(api), {
        installId: INSTALL_ID,
        zoneId: "z-a",
        hostname: "tunnels.example.com",
      }),
    ).rejects.toThrow(
      /needs Workers Routes: Edit on example\.com.*removed what it had already created/,
    );
    expect(world.records["z-a"]).toEqual([]);
    expect(world.routes["z-a"]).toEqual([]);
    expect(await rows()).toEqual([]);
  });
});

describe("settings that use {{wildcardHostname}}", () => {
  it("are deployed again after the domain is added and after it is removed", async () => {
    const { api } = fakeApi();
    const refreshed: string[] = [];
    const withRefresh = {
      ...deps(api),
      refreshVars: async (installId: string) => {
        refreshed.push(installId);
        return { jobId: `job-${refreshed.length}` };
      },
    };
    const added = await addWildcardDomainCore(withRefresh, {
      installId: INSTALL_ID,
      zoneId: "z-a",
      hostname: "tunnels.example.com",
    });
    expect(added).toMatchObject({ settingsJobId: "job-1", settingsNote: null });
    const removed = await removeWildcardDomainCore(withRefresh, {
      installId: INSTALL_ID,
      resourceId: added.resourceId,
    });
    expect(removed).toMatchObject({ settingsJobId: "job-2", settingsNote: null });
    expect(refreshed).toEqual([INSTALL_ID, INSTALL_ID]);
  });

  it("say why they were not deployed again when another job runs, keeping the domain", async () => {
    const { world, api } = fakeApi();
    const added = await addWildcardDomainCore(
      {
        ...deps(api),
        refreshVars: async () => {
          throw new Error("Another job of this install is queued or running");
        },
      },
      { installId: INSTALL_ID, zoneId: "z-a", hostname: "tunnels.example.com" },
    );
    expect(added.settingsJobId).toBeNull();
    expect(added.settingsNote).toContain("Another job of this install is queued or running");
    expect(world.routes["z-a"]).toHaveLength(2);
  });
});

describe("removeWildcardDomainCore", () => {
  it("deletes the routes, then the records, and marks everything deleted", async () => {
    const { world, api } = fakeApi();
    const { resourceId } = await addWildcardDomainCore(deps(api), {
      installId: INSTALL_ID,
      zoneId: "z-a",
      hostname: "tunnels.example.com",
    });
    world.calls.length = 0;
    expect(
      await removeWildcardDomainCore(deps(api), { installId: INSTALL_ID, resourceId }),
    ).toEqual({ hostname: "tunnels.example.com", settingsJobId: null, settingsNote: null });
    expect(world.calls.map((c) => c.replace(/\/[^/]+$/, "/:id"))).toEqual([
      "DELETE /zones/z-a/workers/routes/:id",
      "DELETE /zones/z-a/workers/routes/:id",
      "DELETE /zones/z-a/dns_records/:id",
      "DELETE /zones/z-a/dns_records/:id",
    ]);
    expect(world.records["z-a"]).toEqual([]);
    expect(world.routes["z-a"]).toEqual([]);
    expect((await rows()).every((r) => r.deleted_at === NOW.getTime())).toBe(true);
  });

  it("leaves a route an admin made by hand for the Worker", async () => {
    const { world, api } = fakeApi({
      routes: { "z-a": [{ id: "route-admin", pattern: "*.tunnels.example.com/*", script: "cut" }] },
    });
    const { resourceId } = await addWildcardDomainCore(deps(api), {
      installId: INSTALL_ID,
      zoneId: "z-a",
      hostname: "tunnels.example.com",
    });
    expect((await rows()).map((r) => r.name)).toEqual([
      "tunnels.example.com",
      "tunnels.example.com",
      "*.tunnels.example.com",
      "tunnels.example.com/*",
    ]);
    await removeWildcardDomainCore(deps(api), { installId: INSTALL_ID, resourceId });
    expect(world.routes["z-a"]).toEqual([
      { id: "route-admin", pattern: "*.tunnels.example.com/*", script: "cut" },
    ]);
    expect(world.records["z-a"]).toEqual([]);
  });
});

describe("detachWildcardParts", () => {
  it("counts what is already gone as removed", async () => {
    const { api } = fakeApi();
    const done = await detachWildcardParts(api, [
      { kind: "dns_record", name: "t.example.com", cfId: "z-a/rec-missing" },
      { kind: "worker_route", name: "t.example.com/*", cfId: "z-a/route-missing" },
      { kind: "worker_route", name: "x", cfId: null },
    ]);
    expect(done.map((d) => [d.part.kind, d.outcome])).toEqual([
      ["worker_route", "gone"],
      ["worker_route", "unrecorded"],
      ["dns_record", "gone"],
    ]);
  });
});

describe("other domain kinds for an app that needs a wildcard hostname", () => {
  it("refuses a custom domain", async () => {
    const { api } = fakeApi();
    await expect(
      addCustomDomainCore(deps(api), {
        installId: INSTALL_ID,
        zoneId: "z-a",
        hostname: "a.example.com",
      }),
    ).rejects.toBeInstanceOf(CustomDomainError);
  });

  it("refuses an external domain: wildcard custom hostnames are Enterprise only", async () => {
    const { api } = fakeApi();
    const refused = addExternalDomainCore(deps(api), {
      installId: INSTALL_ID,
      hostname: "tunnels.customer.test",
      validation: "http",
    });
    await expect(refused).rejects.toBeInstanceOf(ExternalDomainError);
    await expect(refused).rejects.toThrow(WILDCARD_EXTERNAL_REFUSAL);
  });
});
