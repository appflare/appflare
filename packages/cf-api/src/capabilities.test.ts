import { describe, expect, it } from "vitest";
import {
  CONTAINERS_PROBE_NAME,
  createCapabilityClient,
  detectedWorkersPlan,
  probeAccountCapabilities,
  probeAccountSetup,
  probeAnalyticsEngine,
  probeContainers,
  probeDomainCapabilities,
  probeEmailRouting,
  probeR2,
  probeWorkersDev,
  probeWorkersPlan,
  probeZeroTrust,
} from "./capabilities";
import { createClient } from "./client";
import { type CapturedRequest, type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";

const TOKEN = "cf-token-DO-NOT-LEAK-123";
const ACCOUNT = "acc-123";
const A = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

function make(handler: (req: CapturedRequest, index: number) => FakeResponseSpec) {
  const fake = makeFakeFetch(handler);
  return {
    fake,
    client: createCapabilityClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch }),
  };
}

/** Cloudflare's answers, as recorded live (ids left out). */
const AUTH_ERROR: FakeResponseSpec = {
  status: 403,
  errors: [{ code: 10000, message: "Authentication error" }],
};
const R2_NOT_ENABLED: FakeResponseSpec = {
  status: 403,
  errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }],
};
const CONTAINERS_NEED_PAID: FakeResponseSpec = {
  status: 401,
  errors: [
    {
      code: 1000,
      message:
        '{"error":"Unauthorized: You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan. Upgrade your plan at https://dash.cloudflare.com/?to=/:account/workers/plans"}',
    },
  ],
};

function subscription(ratePlan: string, extra: Record<string, unknown> = {}) {
  return {
    id: "sub",
    rate_plan: {
      id: ratePlan,
      public_name: ratePlan,
      currency: "USD",
      scope: ratePlan === "free" ? "zone" : "account",
      externally_managed: false,
      sets: null,
      is_contract: false,
    },
    product: { name: ratePlan === "workers_paid" ? "prod_workers" : "prod_other" },
    state: "Paid",
    ...extra,
  };
}

const FREE_ACCOUNT = [subscription("free"), subscription("r2_paid"), subscription("teams_free")];
const PAID_ACCOUNT = [
  subscription("images_v2_stream_basic"),
  subscription("workers_paid", { price: 5 }),
  subscription("teams_free"),
  subscription("r2_paid"),
  subscription("free"),
];
const onePage = { page: 1, per_page: 50, total_pages: 1, count: 3, total_count: 3 };

describe("probeR2", () => {
  it("reads one bucket and says enabled", async () => {
    const { fake, client } = make(() => ({ result: { buckets: [{ name: "b" }] } }));
    expect(await probeR2(client)).toEqual({ state: "enabled" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.last().url).toBe(`${A}/r2/buckets?per_page=1`);
    expect(fake.last().authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("says not enabled on Cloudflare's code 10042", async () => {
    const { client } = make(() => R2_NOT_ENABLED);
    expect(await probeR2(client)).toEqual({ state: "not-enabled" });
  });

  it("cannot tell when the token lacks R2, or on another error", async () => {
    const refused = await probeR2(make(() => AUTH_ERROR).client);
    expect(refused).toMatchObject({ state: "unknown", reason: "no-permission" });
    expect(refused.state === "unknown" && refused.detail).toBe("HTTP 403, Cloudflare code 10000");
    expect(await probeR2(make(() => ({ status: 502, text: "bad gateway" })).client)).toMatchObject({
      state: "unknown",
      reason: "error",
    });
  });
});

describe("probeContainers", () => {
  it("lists applications by name and says available", async () => {
    const { fake, client } = make(() => ({ result: [] }));
    expect(await probeContainers(client)).toEqual({ state: "available" });
    expect(fake.last().url).toBe(
      `${A}/containers/applications?name=${encodeURIComponent(CONTAINERS_PROBE_NAME)}`,
    );
  });

  it("tells the Workers Paid refusal from a missing permission", async () => {
    expect(await probeContainers(make(() => CONTAINERS_NEED_PAID).client)).toEqual({
      state: "needs-workers-paid",
    });
    expect(await probeContainers(make(() => AUTH_ERROR).client)).toMatchObject({
      state: "unknown",
      reason: "no-permission",
    });
  });

  it("never throws, not even on a network failure", async () => {
    const client = createCapabilityClient({
      accountId: ACCOUNT,
      token: TOKEN,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const result = await probeContainers(client);
    expect(result).toEqual({
      state: "unknown",
      reason: "error",
      detail: "no usable answer (TypeError)",
    });
  });
});

describe("probeWorkersPlan", () => {
  it("says paid when the subscriptions list Workers Paid", async () => {
    const { fake, client } = make(() => ({ result: PAID_ACCOUNT, result_info: onePage }));
    expect(await probeWorkersPlan(client)).toEqual({ state: "paid" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.last().url).toBe(`${A}/subscriptions?page=1&per_page=50`);
  });

  it("says free when no Workers entry is listed", async () => {
    const { client } = make(() => ({ result: FREE_ACCOUNT, result_info: onePage }));
    expect(await probeWorkersPlan(client)).toEqual({ state: "free" });
  });

  it("ignores a Workers Paid subscription that is no longer in force", async () => {
    const { client } = make(() => ({
      result: [subscription("workers_paid", { state: "Cancelled" })],
      result_info: onePage,
    }));
    expect(await probeWorkersPlan(client)).toEqual({ state: "free" });
  });

  it("cannot tell for a contract plan without a Workers entry", async () => {
    const { client } = make(() => ({
      result: [subscription("enterprise", { rate_plan: { id: "enterprise", is_contract: true } })],
      result_info: onePage,
    }));
    expect(await probeWorkersPlan(client)).toMatchObject({
      state: "unknown",
      reason: "unrecognised",
    });
  });

  it("reads further pages only until the Workers entry turns up", async () => {
    const { fake, client } = make((req) => {
      const page = Number(req.query.get("page"));
      const info = { page, per_page: 50, total_pages: 3 };
      return page === 2
        ? { result: [subscription("workers_paid")], result_info: info }
        : { result: [subscription("free")], result_info: info };
    });
    expect(await probeWorkersPlan(client)).toEqual({ state: "paid" });
    expect(fake.calls.map((c) => c.query.get("page"))).toEqual(["1", "2"]);
  });

  it("does not read an answer without the list as no subscriptions", async () => {
    const { client } = make(() => ({ text: "" }));
    expect(await probeWorkersPlan(client)).toMatchObject({ state: "unknown", reason: "error" });
  });

  it("cannot tell when the token lacks Billing: Read", async () => {
    const { client } = make(() => AUTH_ERROR);
    expect(await probeWorkersPlan(client)).toMatchObject({
      state: "unknown",
      reason: "no-permission",
    });
  });
});

describe("probeAccountCapabilities", () => {
  it("runs all three with one call each on a Workers Free account and never shows the token", async () => {
    const { fake, client } = make((req) => {
      if (req.path.endsWith("/r2/buckets")) return { result: { buckets: [] } };
      if (req.path.endsWith("/containers/applications")) return CONTAINERS_NEED_PAID;
      return { result: FREE_ACCOUNT, result_info: onePage };
    });
    const result = await probeAccountCapabilities(client);
    expect(result).toEqual({
      r2: { state: "enabled" },
      containers: { state: "needs-workers-paid" },
      workersPlan: { state: "free" },
    });
    expect(fake.calls).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("works with the full client too", async () => {
    const fake = makeFakeFetch(() => AUTH_ERROR);
    const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });
    const result = await probeAccountCapabilities(client);
    expect(result.r2.state).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    // Details carry status and codes only, never the path with the account id.
    expect(JSON.stringify(result)).not.toContain(ACCOUNT);
    expect(result.workersPlan).toEqual({
      state: "unknown",
      reason: "no-permission",
      detail: "HTTP 403, Cloudflare code 10000",
    });
  });
});

const Z = "https://api.cloudflare.com/client/v4/zones";
const ZONE_ID = "zone-123";

/** `GET /zones?account.id=…&status=active&per_page=1` with one zone, as recorded live (ids replaced). */
const ONE_ZONE: FakeResponseSpec = {
  result: [{ id: ZONE_ID, name: "example.com", status: "active", type: "full" }],
  result_info: { page: 1, per_page: 1, total_pages: 1, count: 1, total_count: 1 },
};
const NO_ZONES: FakeResponseSpec = {
  result: [],
  result_info: { page: 1, per_page: 1, total_pages: 0, count: 0, total_count: 0 },
};
/** `GET /zones/{id}/email/routing` on a zone with routing on, as recorded live. */
const ROUTING_SETTINGS: FakeResponseSpec = {
  result: {
    id: "routing-1",
    tag: "routing-1",
    name: "example.com",
    enabled: true,
    created: "2026-09-23T17:06:34.478318Z",
    modified: "2026-09-23T21:31:42.468265Z",
    skip_wizard: false,
    support_subaddress: false,
    synced: true,
    admin_locked: false,
    status: "ready",
  },
};

describe("probeDomainCapabilities", () => {
  it("lists one zone of the account, then reads its Email Routing: two calls", async () => {
    const { fake, client } = make((req) =>
      req.path === "/client/v4/zones" ? ONE_ZONE : ROUTING_SETTINGS,
    );
    expect(await probeDomainCapabilities(client)).toEqual({
      zone: { state: "available" },
      emailRouting: { state: "available" },
    });
    expect(fake.calls.map((c) => c.url)).toEqual([
      `${Z}?account.id=${ACCOUNT}&status=active&per_page=1`,
      `${Z}/${ZONE_ID}/email/routing`,
    ]);
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("counts routing that is still off as available: an install turns it on", async () => {
    const { client } = make((req) =>
      req.path === "/client/v4/zones"
        ? ONE_ZONE
        : {
            result: {
              ...(ROUTING_SETTINGS.result as object),
              enabled: false,
              status: "unconfigured",
            },
          },
    );
    expect((await probeDomainCapabilities(client)).emailRouting).toEqual({ state: "available" });
  });

  it("says none with one call when the account lists no zone", async () => {
    const { fake, client } = make(() => NO_ZONES);
    expect(await probeDomainCapabilities(client)).toEqual({
      zone: { state: "none" },
      emailRouting: { state: "no-zone" },
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("cannot tell Email Routing when the token may not read the zone's settings", async () => {
    const { client } = make((req) => (req.path === "/client/v4/zones" ? ONE_ZONE : AUTH_ERROR));
    expect(await probeDomainCapabilities(client)).toEqual({
      zone: { state: "available" },
      emailRouting: {
        state: "unknown",
        reason: "no-permission",
        detail: "HTTP 403, Cloudflare code 10000",
      },
    });
  });

  it("cannot tell either when the zone list is refused or fails, and skips the second call", async () => {
    const refused = make(() => AUTH_ERROR);
    expect(await probeDomainCapabilities(refused.client)).toEqual({
      zone: {
        state: "unknown",
        reason: "no-permission",
        detail: "HTTP 403, Cloudflare code 10000",
      },
      emailRouting: {
        state: "unknown",
        reason: "no-permission",
        detail: "no zone could be listed: HTTP 403, Cloudflare code 10000",
      },
    });
    expect(refused.fake.calls).toHaveLength(1);

    const down = make(() => ({ status: 502, text: "bad gateway" }));
    const result = await probeDomainCapabilities(down.client);
    expect(result.zone).toMatchObject({ state: "unknown", reason: "error" });
    expect(result.emailRouting).toMatchObject({ state: "unknown", reason: "error" });
  });

  it("does not read an answer without the list as no zones", async () => {
    const { client } = make(() => ({ result: null }));
    expect((await probeDomainCapabilities(client)).zone).toEqual({
      state: "unknown",
      reason: "error",
      detail: "no usable answer (UnreadableZones)",
    });
  });

  it("works with the full client and never shows the token or the account", async () => {
    const fake = makeFakeFetch(() => AUTH_ERROR);
    const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });
    const result = await probeDomainCapabilities(client);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(ACCOUNT);
  });
});

describe("probeEmailRouting", () => {
  it("reads the given zone's settings once", async () => {
    const { fake, client } = make(() => ROUTING_SETTINGS);
    expect(await probeEmailRouting(client, "z 1")).toEqual({ state: "available" });
    expect(fake.calls.map((c) => c.url)).toEqual([`${Z}/z%201/email/routing`]);
  });
});

describe("detectedWorkersPlan", () => {
  const unknown = { state: "unknown", reason: "no-permission", detail: "" } as const;

  it("takes Containers answering as proof of Workers Paid, then the subscriptions", () => {
    // Conflicting answers: no Workers entry in the subscriptions, yet Containers answer.
    expect(
      detectedWorkersPlan({ workersPlan: { state: "free" }, containers: { state: "available" } }),
    ).toBe("paid");
    expect(detectedWorkersPlan({ workersPlan: { state: "free" }, containers: unknown })).toBe(
      "free",
    );
    expect(
      detectedWorkersPlan({
        workersPlan: { state: "paid" },
        containers: { state: "needs-workers-paid" },
      }),
    ).toBe("paid");
    expect(detectedWorkersPlan({ workersPlan: unknown, containers: { state: "available" } })).toBe(
      "paid",
    );
    expect(
      detectedWorkersPlan({ workersPlan: unknown, containers: { state: "needs-workers-paid" } }),
    ).toBe("free");
    expect(detectedWorkersPlan({ workersPlan: unknown, containers: unknown })).toBeNull();
  });
});

describe("probeWorkersDev", () => {
  it("reads the account's workers.dev subdomain", async () => {
    const { fake, client } = make(() => ({ result: { subdomain: "appflare-dev" } }));
    expect(await probeWorkersDev(client)).toEqual({
      state: "registered",
      subdomain: "appflare-dev",
    });
    expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${A}/workers/subdomain`]);
  });

  it("says not registered on code 10007", async () => {
    const { client } = make(() => ({
      status: 404,
      errors: [{ code: 10007, message: "workers.api.error.subdomain_not_found" }],
    }));
    expect(await probeWorkersDev(client)).toEqual({ state: "not-registered" });
  });

  it("says no permission on a refusal, and an error otherwise", async () => {
    expect(await probeWorkersDev(make(() => AUTH_ERROR).client)).toEqual({
      state: "unknown",
      reason: "no-permission",
      detail: "HTTP 403, Cloudflare code 10000",
    });
    expect(await probeWorkersDev(make(() => ({ status: 500 })).client)).toMatchObject({
      state: "unknown",
      reason: "error",
    });
  });
});

describe("probeZeroTrust", () => {
  it("reads the organization's team domain", async () => {
    const { fake, client } = make(() => ({
      result: { auth_domain: "acme.cloudflareaccess.com", name: "acme" },
    }));
    expect(await probeZeroTrust(client)).toEqual({
      state: "exists",
      teamDomain: "acme.cloudflareaccess.com",
    });
    expect(fake.calls.map((c) => c.url)).toEqual([`${A}/access/organizations`]);
  });

  it("says none on a 404 and on an answer without a team domain", async () => {
    const missing = make(() => ({ status: 404, errors: [{ code: 404, message: "not found" }] }));
    expect(await probeZeroTrust(missing.client)).toEqual({ state: "none" });
    expect(await probeZeroTrust(make(() => ({ result: {} })).client)).toEqual({ state: "none" });
  });

  it("says no permission on a 401 or 403", async () => {
    for (const status of [401, 403]) {
      const refused = make(() => ({
        status,
        errors: [{ code: 10000, message: "Authentication error" }],
      }));
      expect(await probeZeroTrust(refused.client)).toMatchObject({
        state: "unknown",
        reason: "no-permission",
      });
    }
  });
});

describe("probeAccountSetup", () => {
  it("runs the three probes and never names the token or the account", async () => {
    const { fake, client } = make((req) =>
      req.path.endsWith("/workers/subdomain") ? { result: { subdomain: "acme" } } : AUTH_ERROR,
    );
    const result = await probeAccountSetup(client);
    expect(result).toEqual({
      workersDev: { state: "registered", subdomain: "acme" },
      zeroTrust: {
        state: "unknown",
        reason: "no-permission",
        detail: "HTTP 403, Cloudflare code 10000",
      },
      analyticsEngine: {
        state: "unknown",
        reason: "no-permission",
        detail: "HTTP 403, Cloudflare code 10000",
      },
    });
    expect(fake.calls).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(ACCOUNT);
  });
});

describe("probeAnalyticsEngine", () => {
  it("lists the datasets with the SQL API and says enabled on an answer", async () => {
    const { fake, client } = make(() => ({
      envelope: { meta: [{ name: "dataset", type: "String" }], data: [], rows: 0 },
    }));
    expect(await probeAnalyticsEngine(client)).toEqual({ state: "enabled" });
    const call = fake.last();
    expect(`${call.method} ${call.url}`).toBe(`POST ${A}/analytics_engine/sql`);
    expect(call.headers.get("content-type")).toBe("text/plain");
    expect(await call.request.clone().text()).toBe("SHOW TABLES");
  });

  it("says not enabled on the SQL service's plain-text 403", async () => {
    const { client } = make(() => ({ status: 403, text: "Authorization error" }));
    expect(await probeAnalyticsEngine(client)).toEqual({ state: "not-enabled" });
  });

  it("says no permission when the API refuses the token with a Cloudflare code", async () => {
    for (const status of [401, 403]) {
      const refused = make(() => ({
        status,
        errors: [{ code: 10000, message: "Authentication error" }],
      }));
      expect(await probeAnalyticsEngine(refused.client)).toEqual({
        state: "unknown",
        reason: "no-permission",
        detail: `HTTP ${status}, Cloudflare code 10000`,
      });
    }
  });

  it("says error on a 5xx, and reads only a 403 as the SQL service's refusal", async () => {
    expect(await probeAnalyticsEngine(make(() => ({ status: 500 })).client)).toMatchObject({
      state: "unknown",
      reason: "error",
    });
    const plain401 = make(() => ({ status: 401, text: "Unauthorized" }));
    expect(await probeAnalyticsEngine(plain401.client)).toMatchObject({
      state: "unknown",
      reason: "no-permission",
    });
  });
});
