import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { CloudflareApiError } from "./errors";
import { type FakeHandler, type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";
import { EmailRoutingShapeError } from "./namespaces/email-routing";

const TOKEN = "cf-token-DO-NOT-LEAK-123";
const ACCOUNT = "acc-123";
const BASE = "https://api.cloudflare.com/client/v4";
const Z = `${BASE}/zones/z1/email/routing`;

function make(spec?: FakeHandler | FakeResponseSpec) {
  const fake = makeFakeFetch(spec);
  const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });
  return { fake, client };
}

const settings = {
  id: "s1",
  name: "example.com",
  enabled: true,
  status: "ready",
  created: "2026-01-01T00:00:00Z",
  tag: "legacy",
};

async function jsonBody(req: { request: Request }): Promise<unknown> {
  return req.request.clone().json();
}

describe("email routing settings", () => {
  it("getSettings -> GET /zones/{id}/email/routing, extra fields kept", async () => {
    const { fake, client } = make({ result: settings });
    const got = await client.emailRouting.getSettings("z1");
    expect(got).toEqual(settings);
    expect(fake.last().method).toBe("GET");
    expect(fake.last().url).toBe(Z);
    expect(fake.last().authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("enableRouting -> POST /dns with an empty body, or the subdomain name", async () => {
    const { fake, client } = make({ result: { ...settings, enabled: true } });
    expect((await client.emailRouting.enableRouting("z1")).enabled).toBe(true);
    expect(fake.last().method).toBe("POST");
    expect(fake.last().url).toBe(`${Z}/dns`);
    expect(await jsonBody(fake.last())).toEqual({});
    await client.emailRouting.enableRouting("z1", { name: "mail.example.com" });
    expect(await jsonBody(fake.last())).toEqual({ name: "mail.example.com" });
  });

  it("disableRouting -> DELETE /dns", async () => {
    const { fake, client } = make({ result: { ...settings, enabled: false } });
    expect((await client.emailRouting.disableRouting("z1")).enabled).toBe(false);
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${Z}/dns`);
  });

  it("getDnsRecords accepts a list or { record: [...] }", async () => {
    const records = [
      { type: "MX", name: "example.com", content: "route1.mx.cloudflare.net", priority: 12 },
      { type: "TXT", name: "example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
    ];
    let shape: unknown = records;
    const { fake, client } = make(() => ({ result: shape }));
    expect(await client.emailRouting.getDnsRecords("z1")).toEqual(records);
    expect(fake.last().url).toBe(`${Z}/dns`);
    shape = { errors: [], record: records };
    expect(await client.emailRouting.getDnsRecords("z1")).toEqual(records);
  });

  it("rejects a settings result without the fields it reads", async () => {
    const { client } = make({ result: { id: "s1" } });
    await expect(client.emailRouting.getSettings("z1")).rejects.toBeInstanceOf(
      EmailRoutingShapeError,
    );
  });

  it("surfaces a refusal as a CloudflareApiError with the path only", async () => {
    const { client } = make({
      status: 403,
      errors: [{ code: 10000, message: "Authentication error" }],
    });
    const error = await client.emailRouting.getSettings("z1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).status).toBe(403);
    expect((error as CloudflareApiError).path).toBe("/zones/z1/email/routing");
    expect(String(error)).not.toContain(TOKEN);
  });
});

describe("email routing rules", () => {
  const rule = (id: string) => ({
    id,
    tag: id,
    name: `rule ${id}`,
    enabled: true,
    priority: 0,
    matchers: [{ type: "literal", field: "to", value: `${id}@example.com` }],
    actions: [{ type: "worker", value: ["inbox"] }],
  });

  it("listRules pages 50 at a time until a short page", async () => {
    const { fake, client } = make((req) => {
      const page = Number(req.query.get("page"));
      const count = page === 1 ? 50 : 3;
      return {
        result: Array.from({ length: count }, (_, i) => rule(`r${page}-${i}`)),
        result_info: { page, per_page: 50, count, total_count: 53 },
      };
    });
    const rules = await client.emailRouting.listRules("z1");
    expect(rules).toHaveLength(53);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.path).toBe("/client/v4/zones/z1/email/routing/rules");
    expect(fake.calls[0]?.query.get("per_page")).toBe("50");
    expect(fake.calls[1]?.query.get("page")).toBe("2");
  });

  it("listRules stops when total_count is reached on a full page", async () => {
    const { fake, client } = make({
      result: Array.from({ length: 50 }, (_, i) => rule(`r${i}`)),
      result_info: { page: 1, per_page: 50, count: 50, total_count: 50 },
    });
    expect(await client.emailRouting.listRules("z1")).toHaveLength(50);
    expect(fake.calls).toHaveLength(1);
  });

  it("listRules fills in missing matchers and actions", async () => {
    const { client } = make({ result: [{ id: "r1" }] });
    expect(await client.emailRouting.listRules("z1")).toEqual([
      { id: "r1", matchers: [], actions: [] },
    ]);
  });

  it("createRule -> POST /rules with the rule", async () => {
    const { fake, client } = make({ result: rule("inbox") });
    const body = {
      name: "Appflare: inbox",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "inbox@example.com" }],
      actions: [{ type: "worker", value: ["inbox"] }],
    };
    const created = await client.emailRouting.createRule("z1", body);
    expect(created.id).toBe("inbox");
    expect(fake.last().method).toBe("POST");
    expect(fake.last().url).toBe(`${Z}/rules`);
    expect(await jsonBody(fake.last())).toEqual(body);
  });

  it("updateRule -> PUT /rules/{id} with the whole rule", async () => {
    const { fake, client } = make({ result: rule("r1") });
    const body = {
      name: "mailbox-api (installed by Appflare)",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "inbox@example.com" }],
      actions: [{ type: "worker", value: ["mailbox-api"] }],
      priority: 3,
    };
    const updated = await client.emailRouting.updateRule("z1", "r1", body);
    expect(updated.id).toBe("r1");
    expect(fake.last().method).toBe("PUT");
    expect(fake.last().url).toBe(`${Z}/rules/r1`);
    expect(await jsonBody(fake.last())).toEqual(body);
  });

  it("deleteRule -> DELETE /rules/{id}", async () => {
    const { fake, client } = make({ result: rule("r1") });
    await client.emailRouting.deleteRule("z1", "r1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${Z}/rules/r1`);
  });

  it("getCatchAll -> GET /rules/catch_all", async () => {
    const catchAll = {
      id: "c1",
      enabled: false,
      matchers: [{ type: "all" }],
      actions: [{ type: "drop" }],
    };
    const { fake, client } = make({ result: catchAll });
    expect(await client.emailRouting.getCatchAll("z1")).toEqual(catchAll);
    expect(fake.last().url).toBe(`${Z}/rules/catch_all`);
  });

  it("updateCatchAll -> PUT /rules/catch_all with the all matcher by default", async () => {
    const { fake, client } = make({
      result: {
        enabled: true,
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: ["inbox"] }],
      },
    });
    await client.emailRouting.updateCatchAll("z1", {
      actions: [{ type: "worker", value: ["inbox"] }],
      enabled: true,
    });
    expect(fake.last().method).toBe("PUT");
    expect(fake.last().url).toBe(`${Z}/rules/catch_all`);
    expect(await jsonBody(fake.last())).toEqual({
      actions: [{ type: "worker", value: ["inbox"] }],
      matchers: [{ type: "all" }],
      enabled: true,
    });
  });
});

describe("destination addresses", () => {
  it("listDestinationAddresses -> GET /accounts/{id}/email/routing/addresses", async () => {
    const address = { id: "a1", email: "me@example.net", verified: "2026-01-01T00:00:00Z" };
    const { fake, client } = make({ result: [address], result_info: { page: 1, total_count: 1 } });
    expect(await client.emailRouting.listDestinationAddresses()).toEqual([address]);
    expect(fake.last().path).toBe(`/client/v4/accounts/${ACCOUNT}/email/routing/addresses`);
    expect(fake.last().query.has("verified")).toBe(false);
  });

  it("passes the verified filter, and accepts unverified addresses", async () => {
    const { fake, client } = make({
      result: [{ id: "a2", email: "new@example.net", verified: null }],
    });
    const got = await client.emailRouting.listDestinationAddresses({ verified: false });
    expect(got[0]?.verified).toBeNull();
    expect(fake.last().query.get("verified")).toBe("false");
  });
});
