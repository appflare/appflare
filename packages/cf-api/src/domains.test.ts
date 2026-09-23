import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { CloudflareApiError } from "./errors";
import { type FakeHandler, type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";
import { DOMAIN_DNS_RECORD_CONFLICT } from "./namespaces/worker-domains";

const TOKEN = "cf-token-DO-NOT-LEAK-123";
const ACCOUNT = "acc-123";
const BASE = "https://api.cloudflare.com/client/v4";
const A = `${BASE}/accounts/${ACCOUNT}`;

function make(spec?: FakeHandler | FakeResponseSpec) {
  const fake = makeFakeFetch(spec);
  const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });
  return { fake, client };
}

describe("zones", () => {
  it("listZones -> GET /zones filtered by account and status, 50 per page", async () => {
    const zone = { id: "z1", name: "example.com", status: "active" };
    const { fake, client } = make({
      result: [zone],
      result_info: { page: 1, per_page: 50, total_pages: 1 },
    });
    expect(await client.zones.listZones({ accountId: ACCOUNT, status: "active" })).toEqual([zone]);
    const req = fake.last();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/client/v4/zones");
    expect(req.query.get("account.id")).toBe(ACCOUNT);
    expect(req.query.get("status")).toBe("active");
    expect(req.query.has("name")).toBe(false);
    expect(req.query.get("per_page")).toBe("50");
    expect(req.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("listZones follows every page", async () => {
    const { fake, client } = make((req) => {
      const page = Number(req.query.get("page"));
      return {
        result: [{ id: `z${page}`, name: `d${page}.com`, status: "active" }],
        result_info: { page, per_page: 50, total_pages: 2 },
      };
    });
    const zones = await client.zones.listZones();
    expect(zones.map((z) => z.id)).toEqual(["z1", "z2"]);
    expect(fake.calls).toHaveLength(2);
  });

  it("listZones stops on an empty account (total_pages 0)", async () => {
    const { fake, client } = make({
      result: [],
      result_info: { page: 1, per_page: 50, total_pages: 0, count: 0, total_count: 0 },
    });
    expect(await client.zones.listZones({ accountId: ACCOUNT })).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });

  it("getZone -> GET /zones/{id}", async () => {
    const { fake, client } = make({ result: { id: "z1", name: "example.com", status: "active" } });
    await client.zones.getZone("z1");
    expect(fake.last().url).toBe(`${BASE}/zones/z1`);
  });

  it("listDnsRecords -> GET /zones/{id}/dns_records?name.exact=", async () => {
    const { fake, client } = make({
      result: [{ id: "r1", type: "A", name: "app.example.com", content: "192.0.2.1" }],
      result_info: { page: 1, total_pages: 1 },
    });
    const records = await client.zones.listDnsRecords("z1", { name: "app.example.com" });
    expect(records).toHaveLength(1);
    expect(fake.last().path).toBe("/client/v4/zones/z1/dns_records");
    expect(fake.last().query.get("name.exact")).toBe("app.example.com");
  });

  it("listWorkerRoutes -> GET /zones/{id}/workers/routes", async () => {
    const { fake, client } = make({ result: [] });
    await client.zones.listWorkerRoutes("z1");
    expect(fake.last().url).toBe(`${BASE}/zones/z1/workers/routes`);
  });
});

describe("workerDomains", () => {
  const domain = {
    id: "d1",
    hostname: "app.example.com",
    service: "cut",
    zone_id: "z1",
    zone_name: "example.com",
    environment: "production",
  };

  it("listDomains -> GET /accounts/{id}/workers/domains with filters, one request", async () => {
    const { fake, client } = make({
      result: [domain],
      result_info: { page: 1, per_page: 0, count: 1, total_count: 1 },
    });
    expect(await client.workerDomains.listDomains({ service: "cut" })).toEqual([domain]);
    const req = fake.last();
    expect(req.path).toBe(`/client/v4/accounts/${ACCOUNT}/workers/domains`);
    expect(req.query.get("service")).toBe("cut");
    expect(req.query.has("hostname")).toBe(false);
    expect(req.query.has("page")).toBe(false);
    expect(fake.calls).toHaveLength(1);
  });

  it("attachDomain -> PUT /workers/domains with the production environment", async () => {
    const { fake, client } = make({ result: domain });
    const res = await client.workerDomains.attachDomain({
      zoneId: "z1",
      hostname: "app.example.com",
      service: "cut",
    });
    expect(res).toEqual(domain);
    const req = fake.last();
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`${A}/workers/domains`);
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.request.json()).toEqual({
      zone_id: "z1",
      hostname: "app.example.com",
      service: "cut",
      environment: "production",
    });
  });

  it("attachDomain sends override_existing_dns_record only when given", async () => {
    const { fake, client } = make({ result: domain });
    await client.workerDomains.attachDomain({
      zoneId: "z1",
      hostname: "app.example.com",
      service: "cut",
      overrideExistingDnsRecord: true,
    });
    expect(await fake.last().request.json()).toMatchObject({ override_existing_dns_record: true });
  });

  it("attachDomain surfaces the DNS record conflict code", async () => {
    const { client } = make({
      status: 409,
      errors: [
        {
          code: DOMAIN_DNS_RECORD_CONFLICT,
          message: "Hostname 'app.example.com' already has externally managed DNS records",
        },
      ],
    });
    const error = await client.workerDomains
      .attachDomain({ zoneId: "z1", hostname: "app.example.com", service: "cut" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).errors[0]?.code).toBe(100117);
    expect((error as CloudflareApiError).message).not.toContain(TOKEN);
  });

  it("detachDomain -> DELETE /workers/domains/{id} and accepts an empty body", async () => {
    const { fake, client } = make((): FakeResponseSpec => ({ text: "" }));
    await client.workerDomains.detachDomain("d 1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/workers/domains/d%201`);
  });
});
