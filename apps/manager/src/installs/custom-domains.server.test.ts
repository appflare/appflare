import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { accessChallenge } from "../test/access-sign-in";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { ACC, TOKEN } from "../test/fake-account";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { checkSubdomainInZone } from "./custom-domain-input";
import {
  addCustomDomainCore,
  CustomDomainError,
  checkCustomDomainCore,
  DOMAIN_SETUP_WINDOW_MS,
  getDomainOptionsCore,
  removeCustomDomainCore,
} from "./custom-domains.server";

/**
 * The custom domain server functions' cores against the local D1 and a
 * stateful fake of the zones, DNS records, and Workers custom domains API.
 */

const NOW = new Date("2026-09-23T12:00:00.000Z");

interface FakeZone {
  id: string;
  name: string;
  status: string;
  account: { id: string };
}

const OTHER_ACCOUNT = "acc0000000000000000000000000000b";

interface ZoneWorld {
  zones: FakeZone[];
  /** DNS records by zone id. */
  records: Record<string, Array<{ id: string; type: string; name: string; content: string }>>;
  domains: Map<string, { hostname: string; service: string; zone_id: string }>;
  /** `METHOD /path` keys answered with this status (403 = missing permission). */
  refuse: Map<string, number>;
  /** Cloudflare error code the next attach answers with (status 409). */
  attachError: number | null;
  calls: string[];
  bodies: unknown[];
  /** Bodies of the Worker subdomain calls (workers.dev on or off). */
  subdomain: unknown[];
  /** Runs before an attach succeeds (to change the database meanwhile). */
  onAttach?: () => Promise<void>;
}

function fakeZoneApi(over: Partial<ZoneWorld> = {}) {
  const world: ZoneWorld = {
    zones: [
      { id: "z-b", name: "beta.dev", status: "active", account: { id: ACC } },
      { id: "z-a", name: "example.com", status: "active", account: { id: ACC } },
      { id: "z-p", name: "pending.org", status: "pending", account: { id: ACC } },
      // A user token can also see zones of the other accounts its user belongs to.
      { id: "z-o", name: "other.net", status: "active", account: { id: OTHER_ACCOUNT } },
    ],
    records: {},
    domains: new Map(),
    refuse: new Map(),
    attachError: null,
    calls: [],
    bodies: [],
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
    world.calls.push(`${key}${url.search}`);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return fail(403, 10000, "auth");
    }
    const refused = world.refuse.get(key);
    if (refused !== undefined) return fail(refused, 10000, "Authentication error");
    if (key === "GET /zones") {
      const page = Number(url.searchParams.get("page") ?? 1);
      return ok(page === 1 ? world.zones : [], {
        result_info: { page, per_page: 50, total_pages: world.zones.length === 0 ? 0 : 1 },
      });
    }
    let m = /^GET \/zones\/([^/]+)$/.exec(key);
    if (m?.[1]) {
      const zone = world.zones.find((z) => z.id === m?.[1]);
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
    m = /^GET \/zones\/([^/]+)\/workers\/routes$/.exec(key);
    if (m?.[1]) return ok([]);
    if (key === "GET /workers/domains") {
      const hostname = url.searchParams.get("hostname");
      return ok(
        [...world.domains]
          .filter(([, d]) => hostname === null || d.hostname === hostname)
          .map(([id, d]) => ({ id, ...d, zone_name: "example.com", environment: "production" })),
      );
    }
    if (key === "PUT /workers/domains") {
      const body = (await request.json()) as {
        hostname: string;
        service: string;
        zone_id: string;
        override_existing_dns_record?: boolean;
      };
      world.bodies.push(body);
      if (world.attachError !== null) {
        const code = world.attachError;
        world.attachError = null;
        return fail(409, code, "conflict");
      }
      await world.onAttach?.();
      const id = `cfd-${world.domains.size + 1}`;
      world.domains.set(id, {
        hostname: body.hostname,
        service: body.service,
        zone_id: body.zone_id,
      });
      return ok({ id, ...body, zone_name: "example.com" });
    }
    m = /^DELETE \/workers\/domains\/([^/]+)$/.exec(key);
    if (m?.[1]) {
      return world.domains.delete(m[1]) ? ok(null) : fail(404, 100114, "not found");
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

function deps(api: ReturnType<typeof fakeZoneApi>["api"]) {
  let n = 0;
  return { db: env.DB, api, now: () => NOW, newId: () => `id${++n}` };
}

async function domainRows() {
  return (
    await env.DB.prepare(
      "SELECT id, kind, binding, name, cf_id, created_at, deleted_at FROM resources WHERE install_id = ?1 AND kind = 'domain' ORDER BY rowid",
    )
      .bind(INSTALL_ID)
      .all()
  ).results;
}

const add = (hostname: string, extra: { overrideExistingDnsRecord?: boolean } = {}) => ({
  installId: INSTALL_ID,
  zoneId: "z-a",
  hostname,
  ...extra,
});

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
});

describe("getDomainOptionsCore", () => {
  it("lists active zones by name, the inactive ones apart, and no missing permission", async () => {
    const { world, api } = fakeZoneApi();
    expect(await getDomainOptionsCore(deps(api))).toEqual({
      zones: [
        { id: "z-b", name: "beta.dev" },
        { id: "z-a", name: "example.com" },
      ],
      inactiveZones: ["pending.org"],
      missing: [],
      noZones: false,
    });
    expect(world.calls).toContain(`GET /zones?account.id=${ACC}&page=1&per_page=50`);
    // The permission probes read the first active zone.
    expect(world.calls).toContain("GET /zones/z-b/workers/routes");
    expect(world.calls).toContain(
      "GET /zones/z-b/dns_records?name.exact=beta.dev&page=1&per_page=100",
    );
  });

  it("names DNS: Edit and Workers Routes: Edit when the zone reads are refused", async () => {
    const { api } = fakeZoneApi({
      refuse: new Map([
        ["GET /zones/z-b/workers/routes", 403],
        ["GET /zones/z-b/dns_records", 403],
      ]),
    });
    const options = await getDomainOptionsCore(deps(api));
    expect(options.missing).toEqual(["DNS: Edit", "Workers Routes: Edit"]);
    expect(options.zones).toHaveLength(2);
  });

  it("cannot tell no zones from no Zone: Read, so names all three", async () => {
    const { api } = fakeZoneApi({ zones: [] });
    expect(await getDomainOptionsCore(deps(api))).toEqual({
      zones: [],
      inactiveZones: [],
      missing: ["Zone: Read", "DNS: Edit", "Workers Routes: Edit"],
      noZones: true,
    });
  });

  it("treats zones of other accounts as not there", async () => {
    const { api } = fakeZoneApi({
      zones: [{ id: "z-o", name: "other.net", status: "active", account: { id: OTHER_ACCOUNT } }],
    });
    expect(await getDomainOptionsCore(deps(api))).toMatchObject({ zones: [], noZones: true });
  });

  it("names Zone: Read when listing zones is refused", async () => {
    const { api } = fakeZoneApi({ refuse: new Map([["GET /zones", 403]]) });
    expect((await getDomainOptionsCore(deps(api))).missing).toEqual(["Zone: Read"]);
  });
});

describe("addCustomDomainCore", () => {
  it("attaches the hostname to the install's Worker and records a domain resource", async () => {
    const { world, api } = fakeZoneApi();
    const result = await addCustomDomainCore(deps(api), add(" Cut.Example.com "));
    expect(result).toEqual({ ok: true, resourceId: "i1:domain:id1", hostname: "cut.example.com" });
    expect(world.bodies).toEqual([
      { zone_id: "z-a", hostname: "cut.example.com", service: "cut", environment: "production" },
    ]);
    expect(await domainRows()).toEqual([
      {
        id: "i1:domain:id1",
        kind: "domain",
        binding: null,
        name: "cut.example.com",
        cf_id: "cfd-1",
        created_at: NOW.getTime(),
        deleted_at: null,
      },
    ]);
  });

  it("attaches the zone's root when the subdomain is left empty", async () => {
    const { world, api } = fakeZoneApi();
    // The add dialog turns an empty subdomain into the zone's own name.
    const checked = checkSubdomainInZone("", "example.com");
    if (!checked.ok) throw new Error(checked.error);
    const result = await addCustomDomainCore(deps(api), add(checked.hostname));
    expect(result).toEqual({ ok: true, resourceId: "i1:domain:id1", hostname: "example.com" });
    expect(world.bodies).toEqual([
      { zone_id: "z-a", hostname: "example.com", service: "cut", environment: "production" },
    ]);
    expect(await domainRows()).toMatchObject([{ name: "example.com", cf_id: "cfd-1" }]);
  });

  it("warns about address records at the hostname and replaces them only when told to", async () => {
    const { world, api } = fakeZoneApi({
      records: {
        "z-a": [
          { id: "r1", type: "A", name: "cut.example.com", content: "192.0.2.1" },
          { id: "r2", type: "TXT", name: "cut.example.com", content: "v=spf1 -all" },
        ],
      },
    });
    const first = await addCustomDomainCore(deps(api), add("cut.example.com"));
    expect(first).toEqual({
      ok: false,
      reason: "dns-conflict",
      hostname: "cut.example.com",
      records: [{ type: "A", content: "192.0.2.1" }],
    });
    expect(world.bodies).toEqual([]);
    expect(await domainRows()).toEqual([]);

    const second = await addCustomDomainCore(
      deps(api),
      add("cut.example.com", { overrideExistingDnsRecord: true }),
    );
    expect(second.ok).toBe(true);
    expect(world.bodies).toEqual([
      {
        zone_id: "z-a",
        hostname: "cut.example.com",
        service: "cut",
        environment: "production",
        override_existing_dns_record: true,
      },
    ]);
  });

  it("reports Cloudflare's own DNS conflict (100117) as a conflict to confirm", async () => {
    const { world, api } = fakeZoneApi({
      attachError: 100117,
      refuse: new Map([["GET /zones/z-a/dns_records", 403]]),
    });
    expect(await addCustomDomainCore(deps(api), add("cut.example.com"))).toEqual({
      ok: false,
      reason: "dns-conflict",
      hostname: "cut.example.com",
      records: [],
    });
    expect(world.domains.size).toBe(0);
    expect(await domainRows()).toEqual([]);
  });

  it("says so when Cloudflare still refuses to replace the records after the admin agreed", async () => {
    const { world, api } = fakeZoneApi({ attachError: 100117 });
    await expect(
      addCustomDomainCore(deps(api), add("cut.example.com", { overrideExistingDnsRecord: true })),
    ).rejects.toThrow(
      new CustomDomainError(
        "Cloudflare would not replace the DNS records at cut.example.com, even when asked to. Delete them in the Cloudflare dashboard (the domain's DNS records) and add the domain again.",
      ),
    );
    expect(world.bodies).toEqual([expect.objectContaining({ override_existing_dns_record: true })]);
    expect(await domainRows()).toEqual([]);
  });

  it("refuses a zone of another account without calling the attach", async () => {
    const { world, api } = fakeZoneApi();
    await expect(
      addCustomDomainCore(deps(api), { ...add("cut.other.net"), zoneId: "z-o" }),
    ).rejects.toThrow(
      new CustomDomainError(
        "other.net belongs to another Cloudflare account, not the one Appflare runs in.",
      ),
    );
    expect(world.bodies).toEqual([]);
    expect(world.calls.some((c) => c.startsWith("GET /workers/domains"))).toBe(false);
  });

  it("refuses a hostname outside the zone without calling the attach", async () => {
    const { world, api } = fakeZoneApi();
    await expect(addCustomDomainCore(deps(api), add("cut.example.org"))).rejects.toThrow(
      new CustomDomainError("The hostname must be example.com or end in .example.com."),
    );
    expect(world.bodies).toEqual([]);
  });

  it("never takes a hostname away from another Worker", async () => {
    const { world, api } = fakeZoneApi({
      domains: new Map([
        ["cfd-x", { hostname: "cut.example.com", service: "blog", zone_id: "z-a" }],
      ]),
    });
    await expect(addCustomDomainCore(deps(api), add("cut.example.com"))).rejects.toThrow(
      /already serves the Worker "blog"/,
    );
    expect(world.bodies).toEqual([]);

    const moved = fakeZoneApi({ attachError: 100116 });
    await expect(addCustomDomainCore(deps(moved.api), add("www.example.com"))).rejects.toThrow(
      /already serves another Worker/,
    );
  });

  it("records a hostname already attached to this Worker without attaching it again", async () => {
    const { world, api } = fakeZoneApi({
      domains: new Map([
        ["cfd-9", { hostname: "cut.example.com", service: "cut", zone_id: "z-a" }],
      ]),
    });
    expect((await addCustomDomainCore(deps(api), add("cut.example.com"))).ok).toBe(true);
    expect(world.bodies).toEqual([]);
    expect((await domainRows())[0]).toMatchObject({ name: "cut.example.com", cf_id: "cfd-9" });
    await expect(addCustomDomainCore(deps(api), add("cut.example.com"))).rejects.toThrow(
      "cut.example.com is already a custom domain of this app.",
    );
  });

  it("refuses an install that is not installed, and an inactive or unseen zone", async () => {
    const { api } = fakeZoneApi();
    await expect(
      addCustomDomainCore(deps(api), { ...add("cut.pending.org"), zoneId: "z-p" }),
    ).rejects.toThrow(/pending\.org is not active on Cloudflare yet \(pending\)/);
    await expect(
      addCustomDomainCore(deps(api), { ...add("cut.example.com"), zoneId: "z-none" }),
    ).rejects.toThrow(/cannot see that zone/);
    await env.DB.prepare("UPDATE installs SET status = 'updating'").run();
    await expect(addCustomDomainCore(deps(api), add("cut.example.com"))).rejects.toThrow(
      "A custom domain can be added only to an installed app; this one is updating.",
    );
  });

  it("names the missing permission when Cloudflare refuses the attach", async () => {
    const { api } = fakeZoneApi({ refuse: new Map([["PUT /workers/domains", 403]]) });
    await expect(addCustomDomainCore(deps(api), add("cut.example.com"))).rejects.toThrow(
      /needs Workers Routes: Edit on example\.com/,
    );
  });

  it("removes the domain again when an uninstall started while it was attached", async () => {
    const { world, api } = fakeZoneApi({
      onAttach: async () => {
        await env.DB.prepare("UPDATE installs SET status = 'uninstalling'").run();
      },
    });
    await expect(addCustomDomainCore(deps(api), add("cut.example.com"))).rejects.toThrow(
      /started uninstalling/,
    );
    expect(world.domains.size).toBe(0);
    expect(world.calls).toContain("DELETE /workers/domains/cfd-1");
    expect(await domainRows()).toEqual([]);
  });
});

describe("a protected app's public paths", () => {
  it("are brought in step after a domain is added, and before and after one is removed", async () => {
    const { world, api } = fakeZoneApi();
    const synced: Array<{ id: string; change?: unknown; detached: boolean }> = [];
    const d = {
      ...deps(api),
      syncAccess: async (id: string, change?: unknown) => {
        synced.push({
          id,
          ...(change === undefined ? {} : { change }),
          detached: world.calls.includes("DELETE /workers/domains/cfd-1"),
        });
        return null;
      },
    };
    // After the domain is attached, from the records.
    await addCustomDomainCore(d, add("cut.example.com"));
    expect(synced).toEqual([{ id: INSTALL_ID, detached: false }]);
    // Before it is released, leaving its hostname out; then from the records.
    await removeCustomDomainCore(d, { installId: INSTALL_ID, resourceId: "i1:domain:id1" });
    expect(synced.slice(1)).toEqual([
      { id: INSTALL_ID, change: { leavingHosts: ["cut.example.com"] }, detached: false },
      { id: INSTALL_ID, detached: true },
    ]);
  });

  it("keep the domain attached when they cannot be taken off it first", async () => {
    const { world, api } = fakeZoneApi();
    const d = { ...deps(api), syncAccess: async () => null as string | null };
    await addCustomDomainCore(d, add("cut.example.com"));
    const failing = {
      ...d,
      syncAccess: async (_id: string, change?: unknown) =>
        change === undefined
          ? null
          : "Another Access change is in progress. Try again in a minute.",
    };
    await expect(
      removeCustomDomainCore(failing, { installId: INSTALL_ID, resourceId: "i1:domain:id1" }),
    ).rejects.toThrow(
      "The app's public paths could not be taken off cut.example.com in Cloudflare Access (Another Access change is in progress. Try again in a minute.), so the domain was not removed and still serves the app. Try again in a minute.",
    );
    expect(world.calls).not.toContain("DELETE /workers/domains/cfd-1");
    expect((await domainRows())[0]?.deleted_at).toBeNull();
  });

  it("cost no Access call for an app Appflare does not protect", async () => {
    const { world, api } = fakeZoneApi();
    await addCustomDomainCore(deps(api), add("cut.example.com"));
    expect(world.calls.filter((c) => c.includes("/access/"))).toEqual([]);
  });
});

describe("removeCustomDomainCore", () => {
  it("detaches the domain and marks the resource deleted; one already gone counts", async () => {
    const { world, api } = fakeZoneApi();
    const d = deps(api);
    await addCustomDomainCore(d, add("cut.example.com"));
    await addCustomDomainCore(d, add("www.example.com"));
    world.domains.delete("cfd-2");

    const first = { installId: INSTALL_ID, resourceId: "i1:domain:id1" };
    expect(await removeCustomDomainCore(d, first)).toEqual({
      hostname: "cut.example.com",
      settingsJobId: null,
      settingsNote: null,
    });
    expect(world.calls).toContain("DELETE /workers/domains/cfd-1");
    expect(world.domains.size).toBe(0);
    await expect(removeCustomDomainCore(d, first)).rejects.toThrow(
      "That is not a custom domain of this app.",
    );

    const second = { installId: INSTALL_ID, resourceId: "i1:domain:id2" };
    expect(await removeCustomDomainCore(d, second)).toEqual({
      hostname: "www.example.com",
      settingsJobId: null,
      settingsNote: null,
    });
    expect((await domainRows()).map((r) => r.deleted_at)).toEqual([NOW.getTime(), NOW.getTime()]);

    // Removed, then added again: a new resource row.
    expect(await addCustomDomainCore(d, add("cut.example.com"))).toMatchObject({
      ok: true,
      resourceId: "i1:domain:id3",
    });
  });

  /** Two live custom domains, workers.dev off, the switch set by `choice`. */
  async function twoLiveDomains(choice: "auto" | "manual") {
    const zone = fakeZoneApi();
    const d = deps(zone.api);
    await addCustomDomainCore(d, add("cut.example.com"));
    await addCustomDomainCore(d, add("www.example.com"));
    await env.DB.batch([
      env.DB.prepare("UPDATE resources SET live_at = 1 WHERE kind = 'domain'"),
      env.DB.prepare(
        "UPDATE installs SET workers_dev_enabled = 0, workers_dev_choice = ?1, served_domain = 'cut.example.com'",
      ).bind(choice),
    ]);
    return { ...zone, d };
  }

  async function workersDev() {
    return env.DB.prepare(
      "SELECT workers_dev_enabled, workers_dev_choice, served_domain FROM installs",
    ).first();
  }

  it("deploys settings that use {{appUrl}} again when the domain that served the app goes, and only then", async () => {
    const { d } = await twoLiveDomains("auto");
    const changed: string[][] = [];
    const withRefresh = {
      ...d,
      refreshVars: async (_installId: string, reasons: readonly string[]) => {
        changed.push([...reasons]);
        return { jobId: "settings-1" };
      },
    };
    // www.example.com does not serve the app: nothing moves.
    expect(
      await removeCustomDomainCore(withRefresh, {
        installId: INSTALL_ID,
        resourceId: "i1:domain:id2",
      }),
    ).toEqual({ hostname: "www.example.com", settingsJobId: null, settingsNote: null });
    expect(changed).toEqual([]);
    // cut.example.com served it: workers.dev takes over, and the settings follow.
    expect(
      await removeCustomDomainCore(withRefresh, {
        installId: INSTALL_ID,
        resourceId: "i1:domain:id1",
      }),
    ).toEqual({ hostname: "cut.example.com", settingsJobId: "settings-1", settingsNote: null });
    expect(changed).toEqual([["appUrl"]]);
  });

  it("refuses to remove the last live domain while an admin turned workers.dev off", async () => {
    const { world, d } = await twoLiveDomains("manual");
    const first = { installId: INSTALL_ID, resourceId: "i1:domain:id1" };
    expect(await removeCustomDomainCore(d, first)).toEqual({
      hostname: "cut.example.com",
      settingsJobId: null,
      settingsNote: null,
    });
    expect(world.subdomain).toEqual([]);
    const last = { installId: INSTALL_ID, resourceId: "i1:domain:id2" };
    await expect(removeCustomDomainCore(d, last)).rejects.toThrow(
      "This is the app's only address: its workers.dev URL is off.",
    );
    expect(world.calls).not.toContain("DELETE /workers/domains/cfd-2");
    expect(world.subdomain).toEqual([]);
  });

  it("turns workers.dev back on before removing the last live domain when Appflare turned it off", async () => {
    const { world, d } = await twoLiveDomains("auto");
    const first = { installId: INSTALL_ID, resourceId: "i1:domain:id1" };
    expect(await removeCustomDomainCore(d, first)).toEqual({
      hostname: "cut.example.com",
      settingsJobId: null,
      settingsNote: null,
    });
    // Another live domain remains: workers.dev stays off.
    expect(world.subdomain).toEqual([]);
    expect(await workersDev()).toMatchObject({ workers_dev_enabled: 0 });

    const last = { installId: INSTALL_ID, resourceId: "i1:domain:id2" };
    expect(await removeCustomDomainCore(d, last)).toEqual({
      hostname: "www.example.com",
      settingsJobId: null,
      settingsNote: null,
    });
    expect(world.subdomain).toEqual([{ script: "cut", enabled: true, previews_enabled: true }]);
    expect(await workersDev()).toEqual({
      workers_dev_enabled: 1,
      workers_dev_choice: "auto",
      served_domain: null,
    });
    // workers.dev is on before the domain goes.
    const on = world.calls.indexOf("POST /workers/scripts/cut/subdomain");
    expect(on).toBeGreaterThan(-1);
    expect(world.calls.indexOf("DELETE /workers/domains/cfd-2")).toBeGreaterThan(on);
  });

  it("moves the served domain to another live one when it is removed", async () => {
    const { world, d } = await twoLiveDomains("manual");
    // A third domain that never reached the app is never served.
    await addCustomDomainCore(d, add("pending.example.com"));
    await removeCustomDomainCore(d, { installId: INSTALL_ID, resourceId: "i1:domain:id1" });
    expect(world.subdomain).toEqual([]);
    expect(await workersDev()).toEqual({
      workers_dev_enabled: 0,
      workers_dev_choice: "manual",
      served_domain: "www.example.com",
    });
  });

  it("drops the served domain while workers.dev is on and no other domain is live", async () => {
    const { d } = await twoLiveDomains("auto");
    await env.DB.batch([
      env.DB.prepare("UPDATE installs SET workers_dev_enabled = 1"),
      env.DB.prepare("UPDATE resources SET live_at = NULL WHERE name = 'www.example.com'"),
    ]);
    await removeCustomDomainCore(d, { installId: INSTALL_ID, resourceId: "i1:domain:id1" });
    expect(await workersDev()).toMatchObject({ workers_dev_enabled: 1, served_domain: null });
  });

  it("counts only live domains as addresses when removing one", async () => {
    const { world, d } = await twoLiveDomains("auto");
    // The other domain never reached the app.
    await env.DB.prepare(
      "UPDATE resources SET live_at = NULL WHERE name = 'www.example.com'",
    ).run();
    const first = { installId: INSTALL_ID, resourceId: "i1:domain:id1" };
    expect(await removeCustomDomainCore(d, first)).toEqual({
      hostname: "cut.example.com",
      settingsJobId: null,
      settingsNote: null,
    });
    expect(world.subdomain).toEqual([{ script: "cut", enabled: true, previews_enabled: true }]);
  });

  it("does not turn workers.dev on under a running job, which would send the old value", async () => {
    const { world, d } = await twoLiveDomains("auto");
    await removeCustomDomainCore(d, { installId: INSTALL_ID, resourceId: "i1:domain:id1" });
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('j1', ?1, 'update', 'running')",
    )
      .bind(INSTALL_ID)
      .run();
    await expect(
      removeCustomDomainCore(d, { installId: INSTALL_ID, resourceId: "i1:domain:id2" }),
    ).rejects.toThrow("a job of the app is running");
    expect(world.subdomain).toEqual([]);
    expect(world.calls).not.toContain("DELETE /workers/domains/cfd-2");
  });

  it("leaves domains to a running uninstall and refuses other kinds of resource", async () => {
    const { api } = fakeZoneApi();
    await addCustomDomainCore(deps(api), add("cut.example.com"));
    await env.DB.prepare(
      "INSERT INTO resources (id, install_id, kind, name, created_at) VALUES ('kv', ?1, 'kv', 'cut-kv', 1)",
    )
      .bind(INSTALL_ID)
      .run();
    await expect(
      removeCustomDomainCore(deps(api), { installId: INSTALL_ID, resourceId: "kv" }),
    ).rejects.toThrow("That is not a custom domain of this app.");
    await env.DB.prepare("UPDATE installs SET status = 'uninstalling'").run();
    await expect(
      removeCustomDomainCore(deps(api), { installId: INSTALL_ID, resourceId: "i1:domain:id1" }),
    ).rejects.toThrow("The uninstall removes this app's custom domains.");
  });
});

describe("checkCustomDomainCore", () => {
  it("probes the health path on the custom hostname once and records nothing", async () => {
    const fixture = await buildArtifactFixture({
      catalog: {
        install: {
          tier: "artifact",
          packageManager: "pnpm",
          wranglerConfig: "wrangler.jsonc",
          workerName: "cut",
          health: { path: "/api/health" },
        },
      },
    });
    await env.DB.prepare("UPDATE installs SET manifest_json = ?1")
      .bind(new TextDecoder().decode(fixture.manifestBytes))
      .run();
    const { api } = fakeZoneApi();
    await addCustomDomainCore(deps(api), add("cut.example.com"));
    const urls: string[] = [];
    const result = await checkCustomDomainCore(
      {
        db: env.DB,
        now: () => NOW,
        fetch: async (input) => {
          urls.push(input);
          return new Response("error code: 1042", { status: 404 });
        },
      },
      { installId: INSTALL_ID, resourceId: "i1:domain:id1" },
    );
    expect(urls).toEqual(["https://cut.example.com/api/health"]);
    expect(result).toEqual({
      hostname: "cut.example.com",
      url: "https://cut.example.com/api/health",
      status: "unverified",
      detail: "404 error code: 1042 (route not live yet)",
      checkedAt: NOW.toISOString(),
      workersDevTurnedOff: false,
      // Cloudflare's own page on a domain added just now.
      settingUp: true,
      settingsJobId: null,
      settingsNote: null,
    });
    const install = await env.DB.prepare(
      "SELECT health_status, workers_dev_enabled FROM installs",
    ).first();
    expect(install).toEqual({ health_status: null, workers_dev_enabled: 1 });
    const live = await env.DB.prepare(
      "SELECT live_at FROM resources WHERE kind = 'domain'",
    ).first();
    expect(live).toEqual({ live_at: null });
  });

  /** One check of the domain added at NOW, `minutes` later, answered with `response`. */
  async function checkAnswering(response: () => Response, minutes: number) {
    const { api } = fakeZoneApi();
    await addCustomDomainCore(deps(api), add("cut.example.com"));
    return checkCustomDomainCore(
      {
        db: env.DB,
        now: () => new Date(NOW.getTime() + minutes * 60_000),
        fetch: async () => response(),
      },
      { installId: INSTALL_ID, resourceId: "i1:domain:id1" },
    );
  }

  it("says a new domain is being set up while Cloudflare answers for it, never that it is unhealthy", async () => {
    const attaching = await checkAnswering(
      () => new Response("error code: 1016", { status: 530 }),
      2,
    );
    expect(attaching).toMatchObject({ status: "unverified", detail: "HTTP 530", settingUp: true });
  });

  it("reads a plain 530 on a new domain the same way", async () => {
    expect(await checkAnswering(() => new Response("", { status: 530 }), 1)).toMatchObject({
      status: "unverified",
      settingUp: true,
    });
  });

  it("reads Cloudflare's timeout page on a new domain as it being set up", async () => {
    expect(
      await checkAnswering(() => new Response("error code: 522", { status: 522 }), 1),
    ).toMatchObject({ status: "unverified", detail: "HTTP 522", settingUp: true });
  });

  it("says a domain is unhealthy once the time it may take has passed", async () => {
    const late = await checkAnswering(
      () => new Response("error code: 1016", { status: 530 }),
      DOMAIN_SETUP_WINDOW_MS / 60_000 + 1,
    );
    expect(late).toMatchObject({ status: "unhealthy", detail: "HTTP 530" });
    expect(late.settingUp).toBeUndefined();
  });

  it("does not read a rate limit on a new domain as it being set up", async () => {
    const limited = await checkAnswering(
      () => new Response("error code: 1015", { status: 429 }),
      1,
    );
    expect(limited.settingUp).toBeUndefined();
  });

  it("does not mistake the app's own failure on a new domain for one being set up", async () => {
    const crashed = await checkAnswering(
      () => new Response("error code: 1101", { status: 500 }),
      1,
    );
    expect(crashed).toMatchObject({ status: "unhealthy" });
    expect(crashed.settingUp).toBeUndefined();
  });

  it("never hides a 530 on a domain that reached the app before", async () => {
    const { api } = fakeZoneApi();
    await addCustomDomainCore(deps(api), add("cut.example.com"));
    await env.DB.prepare("UPDATE resources SET live_at = ?1 WHERE kind = 'domain'")
      .bind(NOW.getTime())
      .run();
    const result = await checkCustomDomainCore(
      {
        db: env.DB,
        now: () => new Date(NOW.getTime() + 60_000),
        fetch: async () => new Response("error code: 1016", { status: 530 }),
      },
      { installId: INSTALL_ID, resourceId: "i1:domain:id1" },
    );
    expect(result).toMatchObject({ status: "unhealthy", detail: "HTTP 530" });
    expect(result.settingUp).toBeUndefined();
  });

  async function checkReaching(opts: { withApi: boolean }) {
    const { world, api } = fakeZoneApi();
    await addCustomDomainCore(deps(api), add("cut.example.com"));
    const result = await checkCustomDomainCore(
      {
        db: env.DB,
        now: () => NOW,
        fetch: async () => new Response("<html>cut</html>"),
        ...(opts.withApi ? { api: async () => api } : {}),
      },
      { installId: INSTALL_ID, resourceId: "i1:domain:id1" },
    );
    const install = await env.DB.prepare(
      "SELECT workers_dev_enabled, served_domain FROM installs",
    ).first();
    const domain = await env.DB.prepare(
      "SELECT live_at FROM resources WHERE kind = 'domain'",
    ).first();
    return { world, result, install, domain };
  }

  it("records the domain as live when Cloudflare Access answers on it, and turns workers.dev off", async () => {
    const { world, api } = fakeZoneApi();
    await addCustomDomainCore(deps(api), add("cut.example.com"));
    const result = await checkCustomDomainCore(
      {
        db: env.DB,
        now: () => NOW,
        fetch: async () => accessChallenge("cut.example.com"),
        api: async () => api,
      },
      { installId: INSTALL_ID, resourceId: "i1:domain:id1" },
    );
    // Live, but the app itself was not checked.
    expect(result).toEqual({
      hostname: "cut.example.com",
      url: "https://cut.example.com/",
      status: "unverified",
      detail: "Cloudflare Access asked for a sign-in",
      access: true,
      checkedAt: NOW.toISOString(),
      workersDevTurnedOff: true,
      settingsJobId: null,
      settingsNote: null,
    });
    // workers.dev goes off, so the app is not left reachable there without Access.
    expect(world.subdomain).toEqual([{ script: "cut", enabled: false, previews_enabled: true }]);
    const install = await env.DB.prepare(
      "SELECT workers_dev_enabled, served_domain FROM installs",
    ).first();
    expect(install).toEqual({ workers_dev_enabled: 0, served_domain: "cut.example.com" });
    const live = await env.DB.prepare(
      "SELECT live_at FROM resources WHERE kind = 'domain'",
    ).first();
    expect(live).toEqual({ live_at: NOW.getTime() });
  });

  it("records the domain as live once the app answers, and turns workers.dev off", async () => {
    const { world, result, install, domain } = await checkReaching({ withApi: true });
    expect(result).toMatchObject({ status: "verified", workersDevTurnedOff: true });
    expect(world.subdomain).toEqual([{ script: "cut", enabled: false, previews_enabled: true }]);
    expect(install).toEqual({ workers_dev_enabled: 0, served_domain: "cut.example.com" });
    expect(domain).toEqual({ live_at: NOW.getTime() });
  });

  it("leaves workers.dev alone once an admin set it", async () => {
    await env.DB.prepare("UPDATE installs SET workers_dev_choice = 'manual'").run();
    const { world, result, install, domain } = await checkReaching({ withApi: true });
    expect(result).toMatchObject({ status: "verified", workersDevTurnedOff: false });
    expect(world.subdomain).toEqual([]);
    expect(install).toEqual({ workers_dev_enabled: 1, served_domain: null });
    expect(domain).toEqual({ live_at: NOW.getTime() });
  });

  it("leaves workers.dev alone while a job of the app runs", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('j1', ?1, 'update', 'queued')",
    )
      .bind(INSTALL_ID)
      .run();
    const { world, result, install } = await checkReaching({ withApi: true });
    expect(result.workersDevTurnedOff).toBe(false);
    expect(world.subdomain).toEqual([]);
    expect(install).toMatchObject({ workers_dev_enabled: 1 });
  });

  it("only records the domain as live without a Cloudflare client", async () => {
    const { world, result, install, domain } = await checkReaching({ withApi: false });
    expect(result.workersDevTurnedOff).toBe(false);
    expect(world.subdomain).toEqual([]);
    expect(install).toMatchObject({ workers_dev_enabled: 1 });
    expect(domain).toEqual({ live_at: NOW.getTime() });
  });
});
