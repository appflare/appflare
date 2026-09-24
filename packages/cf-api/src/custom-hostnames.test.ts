import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { CloudflareApiError } from "./errors";
import { type FakeHandler, type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";
import {
  CUSTOM_HOSTNAME_DUPLICATE,
  CUSTOM_HOSTNAMES_NOT_ENABLED,
} from "./namespaces/custom-hostnames";

const TOKEN = "cf-token-DO-NOT-LEAK-123";
const ACCOUNT = "acc-123";
const BASE = "https://api.cloudflare.com/client/v4";
const A = `${BASE}/accounts/${ACCOUNT}`;

function make(spec?: FakeHandler | FakeResponseSpec) {
  const fake = makeFakeFetch(spec);
  const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });
  return { fake, client };
}

describe("custom hostnames", () => {
  it("quota -> GET /zones/{id}/custom_hostnames/quota", async () => {
    const { fake, client } = make({ result: { allocated: 50000, used: 0, exceeded: false } });
    expect(await client.customHostnames.quota("z1")).toEqual({
      allocated: 50000,
      used: 0,
      exceeded: false,
    });
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(`${BASE}/zones/z1/custom_hostnames/quota`);
  });

  it("quota surfaces code 1404 when Cloudflare for SaaS is off", async () => {
    const { client } = make({
      status: 403,
      errors: [{ code: CUSTOM_HOSTNAMES_NOT_ENABLED, message: "No quota has been allocated" }],
    });
    const error = await client.customHostnames.quota("z1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).errors[0]?.code).toBe(1404);
    expect((error as CloudflareApiError).message).not.toContain(TOKEN);
  });

  it("create -> POST with hostname and a DV certificate by the chosen method", async () => {
    const { fake, client } = make({ result: { id: "ch1", hostname: "app.example.org" } });
    await client.customHostnames.create("z1", { hostname: "app.example.org", sslMethod: "txt" });
    const req = fake.last();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/zones/z1/custom_hostnames`);
    expect(await req.request.json()).toEqual({
      hostname: "app.example.org",
      ssl: { method: "txt", type: "dv" },
    });
  });

  it("create surfaces a duplicate as code 1406", async () => {
    const { client } = make({
      status: 409,
      errors: [{ code: CUSTOM_HOSTNAME_DUPLICATE, message: "Duplicate custom hostname found." }],
    });
    const error = await client.customHostnames
      .create("z1", { hostname: "a.example.org", sslMethod: "http" })
      .catch((e: unknown) => e);
    expect((error as CloudflareApiError).errors[0]?.code).toBe(1406);
  });

  it("list filters by hostname and follows pages", async () => {
    const { fake, client } = make((req) => {
      const page = Number(req.query.get("page"));
      return {
        result: [{ id: `ch${page}`, hostname: "a.example.org", status: "active" }],
        result_info: { page, per_page: 50, total_pages: 2 },
      };
    });
    const rows = await client.customHostnames.list("z1", { hostname: "a.example.org" });
    expect(rows.map((r) => r.id)).toEqual(["ch1", "ch2"]);
    expect(fake.calls[0]?.query.get("hostname")).toBe("a.example.org");
    expect(fake.calls[0]?.query.get("per_page")).toBe("50");
  });

  it("get and delete address one hostname by id", async () => {
    const { fake, client } = make({ result: { id: "ch1" } });
    await client.customHostnames.get("z1", "ch1");
    expect(fake.last().url).toBe(`${BASE}/zones/z1/custom_hostnames/ch1`);
    await client.customHostnames.delete("z1", "ch1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${BASE}/zones/z1/custom_hostnames/ch1`);
  });

  it("fallback origin: get, set with { origin }, delete", async () => {
    const { fake, client } = make({ result: { origin: "gw.example.com", status: "active" } });
    await client.customHostnames.getFallbackOrigin("z1");
    expect(fake.last().url).toBe(`${BASE}/zones/z1/custom_hostnames/fallback_origin`);
    await client.customHostnames.setFallbackOrigin("z1", "gw.example.com");
    expect(fake.last().method).toBe("PUT");
    expect(await fake.last().request.json()).toEqual({ origin: "gw.example.com" });
    await client.customHostnames.deleteFallbackOrigin("z1");
    expect(fake.last().method).toBe("DELETE");
  });
});

describe("zone DNS records and Worker routes", () => {
  it("createDnsRecord -> POST with ttl 1 (automatic) unless given", async () => {
    const { fake, client } = make({ result: { id: "r1", type: "AAAA", name: "gw.example.com" } });
    await client.zones.createDnsRecord("z1", {
      type: "AAAA",
      name: "gw.example.com",
      content: "100::",
      proxied: true,
    });
    expect(fake.last().url).toBe(`${BASE}/zones/z1/dns_records`);
    expect(await fake.last().request.json()).toEqual({
      ttl: 1,
      type: "AAAA",
      name: "gw.example.com",
      content: "100::",
      proxied: true,
    });
  });

  it("deleteDnsRecord -> DELETE /zones/{id}/dns_records/{record}", async () => {
    const { fake, client } = make({ result: { id: "r1" } });
    await client.zones.deleteDnsRecord("z1", "r1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${BASE}/zones/z1/dns_records/r1`);
  });

  it("createWorkerRoute and deleteWorkerRoute", async () => {
    const { fake, client } = make({ result: { id: "rt1", pattern: "*/*", script: "gw" } });
    await client.zones.createWorkerRoute("z1", { pattern: "*/*", script: "gw" });
    expect(fake.last().method).toBe("POST");
    expect(fake.last().url).toBe(`${BASE}/zones/z1/workers/routes`);
    expect(await fake.last().request.json()).toEqual({ pattern: "*/*", script: "gw" });
    await client.zones.deleteWorkerRoute("z1", "rt1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${BASE}/zones/z1/workers/routes/rt1`);
  });
});

describe("KV values", () => {
  it("getValue reads the raw value, and null for a missing key", async () => {
    const { fake, client } = make((req) =>
      req.path.endsWith("/values/app.example.org")
        ? { text: "APP_1" }
        : { status: 404, errors: [{ code: 10009, message: "key not found" }] },
    );
    expect(await client.kv.getValue("ns1", "app.example.org")).toBe("APP_1");
    expect(fake.last().url).toBe(`${A}/storage/kv/namespaces/ns1/values/app.example.org`);
    expect(await client.kv.getValue("ns1", "missing.example.org")).toBeNull();
  });

  it("putValue sends the raw value; deleteValue removes the key (encoded)", async () => {
    const { fake, client } = make({ result: null });
    await client.kv.putValue("ns1", "app.example.org", "APP_1");
    const put = fake.last();
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(`${A}/storage/kv/namespaces/ns1/values/app.example.org`);
    expect(put.headers.get("content-type")).toBe("text/plain");
    expect(await put.request.text()).toBe("APP_1");
    await client.kv.deleteValue("ns1", "a/b");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/storage/kv/namespaces/ns1/values/a%2Fb`);
  });
});
