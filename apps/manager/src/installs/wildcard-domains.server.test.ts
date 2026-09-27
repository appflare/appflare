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

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace("/client/v4", "").replace(`/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    world.calls.push(key);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return fail(403, 10000, "auth");
    const shape = key.replace(/\/(dns_records|routes)\/[^/]+$/, "/$1/:id");
    if (world.refuse.has(shape)) return fail(403, 10000, "Authentication error");
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
        return ok(
          list.filter((r) => r.name === name),
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
      return ok(world.domains.filter((d) => hostname === null || d.hostname === hostname));
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
    expect(attached.parts.map((p) => [p.id, p.created])).toEqual([
      ["rec-old", false],
      [expect.stringMatching(/^rec-/), true],
      ["route-old", false],
      [expect.stringMatching(/^route-/), true],
    ]);
    expect(world.records["z-a"]).toHaveLength(2);
    expect(world.routes["z-a"]).toHaveLength(2);
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

  it("names the permission Cloudflare refused", async () => {
    const { api } = fakeApi({ refuse: new Set(["POST /zones/z-a/workers/routes"]) });
    await expect(
      attachWildcardDomain(api, {
        zone: zoneA,
        hostname: "tunnels.example.com",
        workerName: "cut",
      }),
    ).rejects.toThrow(/needs Workers Routes: Edit on example\.com/);
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
