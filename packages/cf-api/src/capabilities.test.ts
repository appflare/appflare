import { describe, expect, it } from "vitest";
import {
  CONTAINERS_PROBE_NAME,
  createCapabilityClient,
  detectedWorkersPlan,
  probeAccountCapabilities,
  probeContainers,
  probeR2,
  probeWorkersPlan,
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
