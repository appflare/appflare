import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { type ReadyGateway, readGateway, setUpGatewayCore } from "../gateway/gateway.server";
import { fakeSaas, GATEWAY_ZONE } from "../test/fake-saas";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { externalDomainPhase } from "./external-domain-input";
import {
  addExternalDomainCore,
  attachExternalDomain,
  detachExternalDomain,
  ExternalDomainError,
  externalDomainStatusCore,
  parseExternalDomainRef,
  removeExternalDomainCore,
} from "./external-domains.server";

/**
 * External domains of an install against the local D1 and a stateful fake
 * of Cloudflare for SaaS, KV and the gateway Worker.
 */

const NOW = new Date("2026-09-24T15:00:00.000Z");
const TARGET = `appflare-gateway.${GATEWAY_ZONE.name}`;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
});

async function withGateway(saas = fakeSaas()) {
  await setUpGatewayCore(
    { db: env.DB, api: saas.api, sleep: async () => {} },
    {
      zoneId: GATEWAY_ZONE.id,
    },
  );
  return saas;
}

let n = 0;
function deps(saas: ReturnType<typeof fakeSaas>, fetch?: typeof globalThis.fetch) {
  return {
    db: env.DB,
    api: saas.api,
    now: () => NOW,
    newId: () => `01K${String(++n).padStart(23, "0")}`,
    ...(fetch === undefined ? {} : { fetch }),
  };
}

async function rows() {
  return (
    await env.DB.prepare(
      "SELECT id, kind, binding, name, cf_id, deleted_at FROM resources WHERE install_id = ?1 AND kind = 'custom_hostname' ORDER BY rowid",
    )
      .bind(INSTALL_ID)
      .all()
  ).results;
}

describe("addExternalDomainCore", () => {
  it("registers the hostname, binds the gateway to the Worker, routes it, and records it", async () => {
    const saas = await withGateway();
    const { resourceId, status } = await addExternalDomainCore(deps(saas), {
      installId: INSTALL_ID,
      hostname: "Go.Customer.test",
      validation: "http",
    });
    const hostname = saas.world.hostnames[0];
    expect(hostname).toMatchObject({ hostname: "go.customer.test", ssl: { method: "http" } });
    expect(saas.world.patches).toEqual([
      { name: "appflare-gateway", env: { APP_I1: { type: "service", service: "cut" } } },
    ]);
    const kvId = (await readGateway(createDb(env.DB)))?.kvId ?? "";
    expect(saas.world.values[kvId]).toEqual({ "go.customer.test": "APP_I1" });
    expect(await rows()).toEqual([
      {
        id: resourceId,
        kind: "custom_hostname",
        binding: "APP_I1",
        name: "go.customer.test",
        cf_id: `${GATEWAY_ZONE.id}/${hostname?.id}`,
        deleted_at: null,
      },
    ]);
    // Pending: the owner adds one CNAME to the gateway's hostname.
    expect(status).toMatchObject({ active: false, status: "pending", method: "http" });
    expect(status.records).toEqual([
      expect.objectContaining({ type: "CNAME", name: "go.customer.test", value: TARGET }),
    ]);
    expect(status.errors).toEqual(["custom hostname does not CNAME to this zone."]);
    expect(externalDomainPhase(status).label).toBe("Waiting for DNS records");
  });

  it("with TXT validation lists the ownership and certificate records before the CNAME", async () => {
    const saas = await withGateway();
    const { status } = await addExternalDomainCore(deps(saas), {
      installId: INSTALL_ID,
      hostname: "shop.customer.test",
      validation: "txt",
    });
    expect(status.records.map((r) => `${r.type} ${r.name}`)).toEqual([
      "TXT _cf-custom-hostname.shop.customer.test",
      "TXT _acme-challenge.shop.customer.test",
      "CNAME shop.customer.test",
    ]);
  });

  it("refuses names in the account's own zones, and without the gateway", async () => {
    const saas = fakeSaas();
    await expect(
      addExternalDomainCore(deps(saas), {
        installId: INSTALL_ID,
        hostname: "go.customer.test",
        validation: "http",
      }),
    ).rejects.toThrow("Set it up in Settings, Domains first");
    await withGateway(saas);
    await expect(
      addExternalDomainCore(deps(saas), {
        installId: INSTALL_ID,
        hostname: "app.own.example",
        validation: "http",
      }),
    ).rejects.toThrow("Add it as a custom domain instead");
    await expect(
      addExternalDomainCore(deps(saas), {
        installId: INSTALL_ID,
        hostname: `x.${GATEWAY_ZONE.name}`,
        validation: "http",
      }),
    ).rejects.toThrow("gateway domain");
    expect(saas.world.hostnames).toEqual([]);
  });

  it("explains a hostname registered with Cloudflare for SaaS elsewhere (code 1406)", async () => {
    const saas = await withGateway(fakeSaas({ elsewhere: new Set(["taken.customer.test"]) }));
    await expect(
      addExternalDomainCore(deps(saas), {
        installId: INSTALL_ID,
        hostname: "taken.customer.test",
        validation: "http",
      }),
    ).rejects.toThrow("already an external domain of another Cloudflare zone");
    // The claim is given up.
    expect((await rows()).every((r) => r.deleted_at !== null)).toBe(true);
  });

  it("explains a token without SSL and Certificates", async () => {
    const saas = await withGateway();
    saas.world.noSsl = true;
    await expect(
      addExternalDomainCore(deps(saas), {
        installId: INSTALL_ID,
        hostname: "go.customer.test",
        validation: "http",
      }),
    ).rejects.toThrow("lacks SSL and Certificates: Edit");
  });

  it("refuses a hostname some app already has", async () => {
    const saas = await withGateway();
    const add = () =>
      addExternalDomainCore(deps(saas), {
        installId: INSTALL_ID,
        hostname: "go.customer.test",
        validation: "http",
      });
    await add();
    await expect(add()).rejects.toThrow("already a domain of this app");
  });

  it("removes the custom hostname it created when routing it fails", async () => {
    const saas = await withGateway();
    const gateway = (await readGateway(createDb(env.DB))) as ReadyGateway;
    saas.world.failValues = true;
    await expect(
      attachExternalDomain(saas.api, {
        gateway,
        installId: INSTALL_ID,
        workerName: "cut",
        hostname: "go.customer.test",
        method: "http",
        claimedAt: Date.now(),
      }),
    ).rejects.toThrow();
    expect(saas.world.hostnames).toEqual([]);
  });
});

/** A second installed app, Worker `blog`. */
async function seedOtherInstall() {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       status, installed_at, updated_at)
     VALUES ('i2', 'blog', 'blog', 'blog', '1.0.0', 'u', 'installed', 1, 1)`,
  ).run();
}

describe("one hostname, one app", () => {
  it("compares names as Cloudflare sees them: an international name and its Punycode are one", async () => {
    const saas = await withGateway();
    await seedOtherInstall();
    await addExternalDomainCore(deps(saas), {
      installId: INSTALL_ID,
      hostname: "Bücher.customer.test",
      validation: "http",
    });
    expect((await rows())[0]).toMatchObject({ name: "xn--bcher-kva.customer.test" });
    await expect(
      addExternalDomainCore(deps(saas), {
        installId: INSTALL_ID,
        hostname: "xn--bcher-kva.customer.test",
        validation: "http",
      }),
    ).rejects.toThrow("already a domain of this app");
    await expect(
      addExternalDomainCore(deps(saas), {
        installId: "i2",
        hostname: "bücher.customer.test",
        validation: "http",
      }),
    ).rejects.toThrow("already a domain of another app");
    expect(saas.world.hostnames).toHaveLength(1);
    const kvId = (await readGateway(createDb(env.DB)))?.kvId ?? "";
    expect(saas.world.values[kvId]).toEqual({ "xn--bcher-kva.customer.test": "APP_I1" });
  });

  it("refuses a custom hostname made outside the app, and leaves it", async () => {
    const saas = await withGateway();
    saas.world.hostnames.push({
      id: "ch-manual",
      zone: GATEWAY_ZONE.id,
      hostname: "go.customer.test",
      status: "active",
      ssl: { method: "http", status: "active" },
      created_at: "2020-01-01T00:00:00Z",
    });
    await expect(
      addExternalDomainCore(deps(saas), {
        installId: INSTALL_ID,
        hostname: "go.customer.test",
        validation: "http",
      }),
    ).rejects.toThrow("made outside this app");
    expect(saas.world.hostnames.map((h) => h.id)).toEqual(["ch-manual"]);
    expect(saas.world.patches).toEqual([]);
    // The claim is given up: nothing is recorded.
    expect((await rows()).every((r) => r.deleted_at !== null)).toBe(true);
  });

  it("takes over the custom hostname an earlier attempt of the same add made", async () => {
    const saas = await withGateway();
    const claimedAt = Date.now() - 5_000;
    // An add whose answer was lost: the claim exists, Cloudflare made the hostname after it.
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('claim-1', ?1, 'custom_hostname', 'APP_I1', 'go.customer.test', NULL, ?2)`,
    )
      .bind(INSTALL_ID, claimedAt)
      .run();
    saas.world.hostnames.push({
      id: "ch-earlier",
      zone: GATEWAY_ZONE.id,
      hostname: "go.customer.test",
      status: "pending",
      ssl: { method: "http", status: "pending_validation" },
      created_at: new Date(claimedAt + 1_000).toISOString(),
    });
    const { resourceId } = await addExternalDomainCore(deps(saas), {
      installId: INSTALL_ID,
      hostname: "go.customer.test",
      validation: "http",
    });
    expect(resourceId).toBe("claim-1");
    expect(saas.world.hostnames.map((h) => h.id)).toEqual(["ch-earlier"]);
    expect((await rows())[0]).toMatchObject({ cf_id: `${GATEWAY_ZONE.id}/ch-earlier` });
  });

  it("never re-points a routing entry that names another app", async () => {
    const saas = await withGateway();
    const kvId = (await readGateway(createDb(env.DB)))?.kvId ?? "";
    saas.world.values[kvId] = { "go.customer.test": "APP_OTHER" };
    await expect(
      addExternalDomainCore(deps(saas), {
        installId: INSTALL_ID,
        hostname: "go.customer.test",
        validation: "http",
      }),
    ).rejects.toThrow("already routed to another app");
    expect(saas.world.values[kvId]).toEqual({ "go.customer.test": "APP_OTHER" });
    expect(saas.world.hostnames).toEqual([]);
  });

  it("refuses when the token cannot list every zone of the account", async () => {
    const saas = await withGateway();
    // Zone: Read on some zones only: the gateway zone is not listed.
    saas.world.zones = saas.world.zones.filter((z) => z.id !== GATEWAY_ZONE.id);
    await expect(
      addExternalDomainCore(deps(saas), {
        installId: INSTALL_ID,
        hostname: "go.customer.test",
        validation: "http",
      }),
    ).rejects.toThrow("needs Zone: Read on all zones of the account");
    expect(saas.world.hostnames).toEqual([]);
  });
});

describe("detachExternalDomain", () => {
  it("without a recorded id, deletes only a hostname made after the claim, and only its own routing entry", async () => {
    const saas = await withGateway();
    const gateway = await readGateway(createDb(env.DB));
    const kvId = gateway?.kvId ?? "";
    saas.world.values[kvId] = { "old.customer.test": "APP_OTHER", "new.customer.test": "APP_I1" };
    saas.world.hostnames.push(
      {
        id: "ch-old",
        zone: GATEWAY_ZONE.id,
        hostname: "old.customer.test",
        status: "active",
        ssl: { method: "http", status: "active" },
        created_at: "2020-01-01T00:00:00Z",
      },
      {
        id: "ch-new",
        zone: GATEWAY_ZONE.id,
        hostname: "new.customer.test",
        status: "active",
        ssl: { method: "http", status: "active" },
        created_at: new Date().toISOString(),
      },
    );
    const claimedAt = Date.now() - 10_000;
    expect(
      await detachExternalDomain(saas.api, gateway, {
        hostname: "old.customer.test",
        cfId: null,
        binding: "APP_I1",
        claimedAt,
      }),
    ).toBe("left");
    expect(
      await detachExternalDomain(saas.api, gateway, {
        hostname: "new.customer.test",
        cfId: null,
        binding: "APP_I1",
        claimedAt,
      }),
    ).toBe("removed");
    expect(saas.world.hostnames.map((h) => h.id)).toEqual(["ch-old"]);
    expect(saas.world.values[kvId]).toEqual({ "old.customer.test": "APP_OTHER" });
  });
});

describe("externalDomainStatusCore", () => {
  it("reads the state and, once active, probes the app through the domain", async () => {
    const saas = await withGateway();
    const { resourceId } = await addExternalDomainCore(deps(saas), {
      installId: INSTALL_ID,
      hostname: "go.customer.test",
      validation: "http",
    });
    saas.activate("go.customer.test");
    const probed: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      probed.push(String(input));
      return new Response("ok");
    }) as typeof globalThis.fetch;
    const status = await externalDomainStatusCore(deps(saas, fetch), {
      installId: INSTALL_ID,
      resourceId,
      probe: true,
    });
    expect(status).toMatchObject({ active: true, records: [], errors: [] });
    expect(status.health).toMatchObject({
      status: "verified",
      url: "https://go.customer.test/",
    });
    expect(probed).toEqual(["https://go.customer.test/"]);
    expect(externalDomainPhase(status)).toEqual({ label: "Active", tone: "success" });
  });

  async function probeActive(applyDefaults: boolean, answer: Response) {
    const saas = await withGateway();
    const { resourceId } = await addExternalDomainCore(deps(saas), {
      installId: INSTALL_ID,
      hostname: "go.customer.test",
      validation: "http",
    });
    saas.activate("go.customer.test");
    const fetch = (async () => answer) as unknown as typeof globalThis.fetch;
    const status = await externalDomainStatusCore(deps(saas, fetch), {
      installId: INSTALL_ID,
      resourceId,
      probe: true,
      applyDefaults,
    });
    const install = await env.DB.prepare(
      "SELECT workers_dev_enabled, served_domain FROM installs",
    ).first();
    const domain = await env.DB.prepare("SELECT live_at FROM resources WHERE id = ?1")
      .bind(resourceId)
      .first();
    return { saas, status, install, domain };
  }

  it("turns workers.dev off for an admin once the app answers through the domain", async () => {
    const { saas, status, install, domain } = await probeActive(true, new Response("ok"));
    expect(status.workersDevTurnedOff).toBe(true);
    expect(saas.world.subdomain).toEqual([
      { script: "cut", enabled: false, previews_enabled: true },
    ]);
    expect(install).toEqual({ workers_dev_enabled: 0, served_domain: "go.customer.test" });
    expect(domain).toEqual({ live_at: NOW.getTime() });
  });

  it("only records the domain as live when a member reads it", async () => {
    const { saas, status, install, domain } = await probeActive(false, new Response("ok"));
    expect(status.workersDevTurnedOff).toBeUndefined();
    expect(saas.world.subdomain).toEqual([]);
    expect(install).toEqual({ workers_dev_enabled: 1, served_domain: null });
    expect(domain).toEqual({ live_at: NOW.getTime() });
  });

  it("does not count a server error through the domain as live", async () => {
    const { saas, status, domain } = await probeActive(true, new Response("oops", { status: 502 }));
    expect(status.health?.status).toBe("unhealthy");
    expect(saas.world.subdomain).toEqual([]);
    expect(domain).toEqual({ live_at: null });
  });

  it("says so when Cloudflare no longer has the custom hostname", async () => {
    const saas = await withGateway();
    const { resourceId } = await addExternalDomainCore(deps(saas), {
      installId: INSTALL_ID,
      hostname: "go.customer.test",
      validation: "http",
    });
    saas.world.hostnames = [];
    const status = await externalDomainStatusCore(deps(saas), {
      installId: INSTALL_ID,
      resourceId,
    });
    expect(status.status).toBe("missing");
    expect(externalDomainPhase(status).tone).toBe("problem");
  });
});

describe("removeExternalDomainCore", () => {
  it("removes the hostname and its routing entry; the last one takes the binding with it", async () => {
    const saas = await withGateway();
    const add = (hostname: string) =>
      addExternalDomainCore(deps(saas), { installId: INSTALL_ID, hostname, validation: "http" });
    const first = await add("a.customer.test");
    const second = await add("b.customer.test");
    const kvId = (await readGateway(createDb(env.DB)))?.kvId ?? "";

    await removeExternalDomainCore(deps(saas), {
      installId: INSTALL_ID,
      resourceId: first.resourceId,
    });
    expect(saas.world.hostnames.map((h) => h.hostname)).toEqual(["b.customer.test"]);
    expect(saas.world.values[kvId]).toEqual({ "b.customer.test": "APP_I1" });
    expect(saas.world.patches).toHaveLength(1);

    await removeExternalDomainCore(deps(saas), {
      installId: INSTALL_ID,
      resourceId: second.resourceId,
    });
    expect(saas.world.hostnames).toEqual([]);
    expect(saas.world.patches.at(-1)).toEqual({ name: "appflare-gateway", env: { APP_I1: null } });
    expect((await rows()).every((r) => r.deleted_at !== null)).toBe(true);
  });

  async function onlyAddress(choice: "auto" | "manual") {
    const saas = await withGateway();
    const { resourceId } = await addExternalDomainCore(deps(saas), {
      installId: INSTALL_ID,
      hostname: "go.customer.test",
      validation: "http",
    });
    await env.DB.batch([
      env.DB.prepare("UPDATE resources SET live_at = 1 WHERE id = ?1").bind(resourceId),
      env.DB.prepare(
        "UPDATE installs SET workers_dev_enabled = 0, workers_dev_choice = ?2, served_domain = 'go.customer.test' WHERE id = ?1",
      ).bind(INSTALL_ID, choice),
    ]);
    return { saas, resourceId };
  }

  it("refuses to remove the app's only address while an admin turned workers.dev off", async () => {
    const { saas, resourceId } = await onlyAddress("manual");
    await expect(
      removeExternalDomainCore(deps(saas), { installId: INSTALL_ID, resourceId }),
    ).rejects.toThrow(ExternalDomainError);
    expect(saas.world.hostnames).toHaveLength(1);
    expect(saas.world.subdomain).toEqual([]);
  });

  it("turns workers.dev back on first when Appflare turned it off", async () => {
    const { saas, resourceId } = await onlyAddress("auto");
    await removeExternalDomainCore(deps(saas), { installId: INSTALL_ID, resourceId });
    expect(saas.world.subdomain).toEqual([
      { script: "cut", enabled: true, previews_enabled: true },
    ]);
    expect(saas.world.hostnames).toEqual([]);
    const install = await env.DB.prepare(
      "SELECT workers_dev_enabled, workers_dev_choice, served_domain FROM installs",
    ).first();
    expect(install).toEqual({
      workers_dev_enabled: 1,
      workers_dev_choice: "auto",
      served_domain: null,
    });
  });
});

describe("parseExternalDomainRef", () => {
  it("reads `<zone id>/<custom hostname id>` and nothing else", () => {
    expect(parseExternalDomainRef("z1/ch1")).toEqual({ zoneId: "z1", customHostnameId: "ch1" });
    expect(parseExternalDomainRef("ch1")).toBeNull();
    expect(parseExternalDomainRef(null)).toBeNull();
    expect(parseExternalDomainRef("a/b/c")).toBeNull();
  });
});
