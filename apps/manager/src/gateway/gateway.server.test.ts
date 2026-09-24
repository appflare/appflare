import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { fakeSaas, GATEWAY_ZONE } from "../test/fake-saas";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { GATEWAY_CODE_VERSION } from "./gateway";
import {
  bindGatewayService,
  checkGatewayZoneCore,
  GATEWAY_BINDING_MESSAGE,
  getGatewayViewCore,
  isGatewayReady,
  type ReadyGateway,
  readGateway,
  setUpGatewayCore,
  turnOffGatewayCore,
  unbindGatewayService,
} from "./gateway.server";

/**
 * The gateway's setup, binding changes and turning off, against the local
 * D1 and a stateful fake of the zone, SaaS, KV and Workers calls.
 */

const NOW = new Date("2026-09-24T15:00:00.000Z");
const HOST = `appflare-gateway.${GATEWAY_ZONE.name}`;

function deps(api: ReturnType<typeof fakeSaas>["api"], fetch?: typeof globalThis.fetch) {
  return {
    db: env.DB,
    api,
    now: () => NOW,
    sleep: async () => {},
    ...(fetch === undefined ? {} : { fetch }),
  };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
});

async function setUp(saas = fakeSaas()) {
  const state = await setUpGatewayCore(deps(saas.api), { zoneId: GATEWAY_ZONE.id });
  return { saas, state };
}

describe("checkGatewayZoneCore", () => {
  it("reports ready with the zone's quota when Cloudflare for SaaS is on", async () => {
    const saas = fakeSaas();
    expect(await checkGatewayZoneCore(deps(saas.api), { zoneId: GATEWAY_ZONE.id })).toEqual({
      kind: "ready",
      used: 0,
      allocated: 50000,
      zoneName: GATEWAY_ZONE.name,
    });
  });

  it("detects SaaS off (code 1404) and links the dashboard page that turns it on", async () => {
    const saas = fakeSaas({ saasOff: new Set([GATEWAY_ZONE.id]) });
    const check = await checkGatewayZoneCore(deps(saas.api), { zoneId: GATEWAY_ZONE.id });
    expect(check).toMatchObject({ kind: "saas-off", zoneName: GATEWAY_ZONE.name });
    expect(check.kind === "saas-off" && check.dashboardUrl).toContain(
      `/${GATEWAY_ZONE.name}/ssl-tls/custom-hostnames`,
    );
  });

  it("detects the missing SSL and Certificates permission (403 code 10000)", async () => {
    const saas = fakeSaas({ noSsl: true });
    expect(await checkGatewayZoneCore(deps(saas.api), { zoneId: GATEWAY_ZONE.id })).toEqual({
      kind: "missing-permission",
      permission: "SSL and Certificates: Edit",
      zoneName: GATEWAY_ZONE.name,
    });
  });
});

describe("setUpGatewayCore", () => {
  it("creates the originless record, fallback origin, routing table, Worker and catch-all route", async () => {
    const { saas, state } = await setUp();
    const { world } = saas;
    expect(world.records).toEqual([
      expect.objectContaining({ type: "AAAA", name: HOST, content: "100::", proxied: true }),
    ]);
    expect(world.fallback[GATEWAY_ZONE.id]).toEqual({ origin: HOST, status: "active" });
    expect(world.kv).toEqual([{ id: state.kvId, title: "appflare-gateway-routes" }]);
    expect(world.routes).toEqual([
      expect.objectContaining({ pattern: "*/*", script: "appflare-gateway" }),
    ]);
    const upload = world.uploads[0];
    expect(upload?.name).toBe("appflare-gateway");
    expect(upload?.modules).toEqual(["gateway.js"]);
    expect(upload?.metadata.compatibility_flags).toEqual([]);
    expect(upload?.metadata.bindings).toEqual([
      { type: "kv_namespace", name: "ROUTES", namespace_id: state.kvId },
      { type: "plain_text", name: "ZONE_NAME", text: GATEWAY_ZONE.name },
      { type: "plain_text", name: "CNAME_TARGET", text: HOST },
      { type: "plain_text", name: "GATEWAY_VERSION", text: GATEWAY_CODE_VERSION },
    ]);
    expect(state).toMatchObject({
      zoneId: GATEWAY_ZONE.id,
      recordCreated: true,
      fallbackSet: true,
      workerUploaded: true,
      readyAt: NOW.toISOString(),
    });
    expect(isGatewayReady(await readGateway(createDb(env.DB)))).toBe(true);
  });

  it("adopts a proxied record and an existing fallback origin, and turning off leaves them", async () => {
    const saas = fakeSaas({
      records: [
        {
          id: "rec-old",
          zone: GATEWAY_ZONE.id,
          type: "CNAME",
          name: HOST,
          content: "elsewhere.example",
          proxied: true,
        },
      ],
      fallback: { [GATEWAY_ZONE.id]: { origin: "origin.gateway.example", status: "active" } },
    });
    const { state } = await setUp(saas);
    expect(state).toMatchObject({ recordId: "rec-old", recordCreated: false, fallbackSet: false });
    await turnOffGatewayCore(deps(saas.api));
    expect(saas.world.records.map((r) => r.id)).toEqual(["rec-old"]);
    expect(saas.world.fallback[GATEWAY_ZONE.id]?.origin).toBe("origin.gateway.example");
    expect(saas.world.routes).toEqual([]);
    expect(saas.world.scripts["appflare-gateway"]).toBeUndefined();
    expect(saas.world.kv).toEqual([]);
    expect(await readGateway(createDb(env.DB))).toBeNull();
  });

  it("refuses a zone without Cloudflare for SaaS before creating anything", async () => {
    const saas = fakeSaas({ saasOff: new Set([GATEWAY_ZONE.id]) });
    await expect(setUp(saas)).rejects.toThrow(
      `Cloudflare for SaaS is off for ${GATEWAY_ZONE.name}`,
    );
    expect(saas.world.records).toEqual([]);
    expect(await readGateway(createDb(env.DB))).toBeNull();
  });

  it("refuses a zone whose every request already goes to another Worker", async () => {
    const saas = fakeSaas({
      routes: [{ id: "r0", zone: GATEWAY_ZONE.id, pattern: "*/*", script: "someone-else" }],
    });
    await expect(setUp(saas)).rejects.toThrow('the Worker "someone-else"');
    expect(saas.world.records).toEqual([]);
  });

  it("refuses a gateway hostname with a record that is not proxied", async () => {
    const saas = fakeSaas({
      records: [
        {
          id: "rec-dns-only",
          zone: GATEWAY_ZONE.id,
          type: "A",
          name: HOST,
          content: "192.0.2.1",
          proxied: false,
        },
      ],
    });
    await expect(setUp(saas)).rejects.toThrow("not proxied through Cloudflare");
  });

  it("continues a setup that stopped half way without creating anything twice", async () => {
    const saas = fakeSaas();
    await setUp(saas);
    // As if the route had not been created yet.
    const state = await readGateway(createDb(env.DB));
    await env.DB.prepare("UPDATE settings SET value = ?1 WHERE key = 'external_domains_gateway'")
      .bind(JSON.stringify({ ...state, routeId: null, readyAt: null }))
      .run();
    await setUp(saas);
    expect(saas.world.records).toHaveLength(1);
    expect(saas.world.kv).toHaveLength(1);
    expect(saas.world.routes).toHaveLength(1);
  });

  it("refuses moving to another zone while a gateway exists", async () => {
    const saas = fakeSaas();
    await setUp(saas);
    await expect(setUpGatewayCore(deps(saas.api), { zoneId: "z-own" })).rejects.toThrow(
      "Turn it off before moving it",
    );
  });
});

describe("gateway service bindings", () => {
  async function ready() {
    const { saas } = await setUp();
    const gateway = (await readGateway(createDb(env.DB))) as ReadyGateway;
    return { saas, gateway };
  }

  it("adds a binding with a merge patch and deploys it; a second add changes nothing", async () => {
    const { saas, gateway } = await ready();
    const wanted = { binding: "APP_I1", service: "cut" };
    expect(await bindGatewayService(saas.api, gateway, wanted)).toBe("patched");
    expect(saas.world.patches).toEqual([
      { name: "appflare-gateway", env: { APP_I1: { type: "service", service: "cut" } } },
    ]);
    expect(saas.world.deployments).toEqual([{ name: "appflare-gateway", version: "v-1" }]);
    expect(await bindGatewayService(saas.api, gateway, wanted)).toBe("unchanged");
    expect(saas.world.patches).toHaveLength(1);
    expect(await unbindGatewayService(saas.api, gateway, "APP_I1")).toBe("patched");
    expect(saas.world.patches[1]).toEqual({ name: "appflare-gateway", env: { APP_I1: null } });
    expect(saas.world.scripts["appflare-gateway"]?.some((b) => b.name === "APP_I1")).toBe(false);
    expect(await unbindGatewayService(saas.api, gateway, "APP_I1")).toBe("unchanged");
  });

  it("uploads a gateway running older code again, keeping its other services", async () => {
    const { saas, gateway } = await ready();
    saas.world.scripts["appflare-gateway"] = [
      { type: "plain_text", name: "GATEWAY_VERSION", text: "0" },
      { type: "service", name: "APP_OTHER", service: "other" },
    ];
    expect(await bindGatewayService(saas.api, gateway, { binding: "APP_I1", service: "cut" })).toBe(
      "uploaded",
    );
    const bindings = saas.world.uploads.at(-1)?.metadata.bindings as Array<{ name: string }>;
    expect(bindings.map((b) => b.name)).toEqual([
      "ROUTES",
      "ZONE_NAME",
      "CNAME_TARGET",
      "GATEWAY_VERSION",
      "APP_OTHER",
      "APP_I1",
    ]);
    expect(saas.world.patches).toEqual([]);
  });

  it("annotates every version it makes", async () => {
    const { saas, gateway } = await ready();
    await bindGatewayService(saas.api, gateway, { binding: "APP_I1", service: "cut" });
    expect(GATEWAY_BINDING_MESSAGE).toBe("Appflare: external domains changed");
  });
});

describe("turnOffGatewayCore", () => {
  it("is refused while an app has an external domain", async () => {
    const { saas } = await setUp();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('r1', ?1, 'custom_hostname', 'APP_I1', 'go.customer.test', 'z-gw/ch-1', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    await expect(turnOffGatewayCore(deps(saas.api))).rejects.toThrow("go.customer.test");
    expect(saas.world.routes).toHaveLength(1);
  });

  it("removes the route, Worker, fallback origin, record and routing table it created", async () => {
    const { saas } = await setUp();
    await turnOffGatewayCore(deps(saas.api));
    expect(saas.world.routes).toEqual([]);
    expect(saas.world.scripts).toEqual({});
    expect(saas.world.fallback).toEqual({});
    expect(saas.world.records).toEqual([]);
    expect(saas.world.kv).toEqual([]);
    expect(await readGateway(createDb(env.DB))).toBeNull();
    // Nothing left: a second run changes nothing.
    await turnOffGatewayCore(deps(saas.api));
  });
});

describe("turnOffGatewayCore, record still in use", () => {
  it("retries the record's delete while its fallback origin is still being deleted", async () => {
    const { saas } = await setUp();
    saas.world.recordBusy = 2;
    await turnOffGatewayCore(deps(saas.api));
    expect(saas.world.records).toEqual([]);
    expect(
      saas.world.calls.filter((c) => c.startsWith("DELETE /zones/z-gw/dns_records/")),
    ).toHaveLength(3);
  });
});

describe("getGatewayViewCore", () => {
  it("offers the account's active zones before setup", async () => {
    const saas = fakeSaas();
    const view = await getGatewayViewCore(deps(saas.api));
    expect(view.gateway).toBeNull();
    expect(view.zones?.map((z) => z.name)).toEqual([GATEWAY_ZONE.name, "own.example"]);
  });

  it("shows the gateway, its SaaS check and whether it answers on its hostname", async () => {
    const { saas } = await setUp();
    const probes: string[] = [];
    const answering = async (input: RequestInfo | URL) => {
      probes.push(String(input));
      return Response.json({ service: "appflare-gateway", version: "1" });
    };
    const view = await getGatewayViewCore(deps(saas.api, answering as typeof fetch));
    expect(view.gateway).toMatchObject({
      zoneName: GATEWAY_ZONE.name,
      hostname: HOST,
      ready: true,
      answering: true,
      check: { kind: "ready" },
      domains: [],
    });
    expect(probes).toEqual([`https://${HOST}/`]);
  });
});
