import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { CloudflareApiError } from "./errors";
import { type FakeHandler, type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";
import { UNREADABLE_CONTAINER_APPLICATIONS } from "./namespaces/containers";

const TOKEN = "cf-token-DO-NOT-LEAK-123";
const ACCOUNT = "acc-123";
const A = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

function make(spec?: FakeResponseSpec | FakeHandler) {
  const fake = makeFakeFetch(spec);
  const client = createClient({ accountId: ACCOUNT, token: TOKEN, fetch: fake.fetch });
  return { fake, client };
}

describe("containers", () => {
  it("listApplications -> GET /containers/applications with the name filter", async () => {
    const { fake, client } = make({
      result: [{ id: "app1", name: "appflare-sandbox-standard-1" }],
    });
    const apps = await client.containers.listApplications({ name: "appflare-sandbox-standard-1" });
    expect(apps).toEqual([{ id: "app1", name: "appflare-sandbox-standard-1" }]);
    expect(fake.last().method).toBe("GET");
    expect(fake.last().path).toBe(`/client/v4/accounts/${ACCOUNT}/containers/applications`);
    expect(fake.last().query.get("name")).toBe("appflare-sandbox-standard-1");
  });

  it("listApplications reads the list in one call, without page parameters", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: `app${i}`, name: `a${i}` }));
    const { fake, client } = make({ result: many });
    expect(await client.containers.listApplications()).toEqual(many);
    expect(fake.calls).toHaveLength(1);
    expect(fake.last().query.get("page")).toBeNull();
    expect(fake.last().query.get("name")).toBeNull();
  });

  it("listApplications throws on an answer without the list", async () => {
    for (const result of [null, {}, "none"]) {
      const { client } = make({ result });
      const error = await client.containers.listApplications().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe(UNREADABLE_CONTAINER_APPLICATIONS);
      expect((error as Error).message).toBe(
        "Cloudflare's answer for the container applications holds no list",
      );
    }
    // An empty list is an answer: the account has none.
    expect(await make({ result: [] }).client.containers.listApplications()).toEqual([]);
  });

  it("getApplication -> GET /containers/applications/{id}", async () => {
    const { fake, client } = make({
      result: { id: "app1", name: "a", health: { instances: { healthy: 2 } } },
    });
    const app = await client.containers.getApplication("app1");
    expect(app.health?.instances?.healthy).toBe(2);
    expect(fake.last().url).toBe(`${A}/containers/applications/app1`);
  });

  it("createApplication -> POST /containers/applications with the body as given", async () => {
    const { fake, client } = make({ status: 201, result: { id: "app1", name: "a" } });
    const body = {
      name: "appflare-sandbox-standard-1",
      scheduling_policy: "default",
      instances: 0,
      max_instances: 2,
      configuration: {
        image: "docker.io/mendylanda/appflare-sandbox:0.1.2",
        instance_type: "standard-1",
      },
      constraints: { tiers: [1, 2] },
      observability: { logs: { enabled: true } },
      durable_objects: { namespace_id: "ns1" },
      rollout_active_grace_period: 0,
    };
    expect(await client.containers.createApplication(body)).toEqual({ id: "app1", name: "a" });
    expect(fake.last().method).toBe("POST");
    expect(fake.last().url).toBe(`${A}/containers/applications`);
    expect(await fake.last().request.json()).toEqual(body);
  });

  it("modifyApplication -> PATCH /containers/applications/{id}", async () => {
    const { fake, client } = make({ result: { id: "app1", name: "a" } });
    await client.containers.modifyApplication("app1", {
      max_instances: 1,
      configuration: { image: "img:2", instance_type: "standard-2" },
    });
    expect(fake.last().method).toBe("PATCH");
    expect(fake.last().url).toBe(`${A}/containers/applications/app1`);
    expect(await fake.last().request.json()).toEqual({
      max_instances: 1,
      configuration: { image: "img:2", instance_type: "standard-2" },
    });
  });

  it("deleteApplication -> DELETE /containers/applications/{id}", async () => {
    const { fake, client } = make({ result: null });
    await client.containers.deleteApplication("app/1");
    expect(fake.last().method).toBe("DELETE");
    expect(fake.last().url).toBe(`${A}/containers/applications/app%2F1`);
  });

  it("createRollout -> POST /containers/applications/{id}/rollouts", async () => {
    const { fake, client } = make({ result: { id: "r1", status: "pending" } });
    const body = {
      description: "Progressive update",
      strategy: "rolling" as const,
      kind: "full_auto" as const,
      target_configuration: { image: "img:2", instance_type: "standard-1" },
      steps: [
        { step_size: { percentage: 10 }, description: "Step 1 of 2" },
        { step_size: { percentage: 100 }, description: "Step 2 of 2" },
      ],
    };
    expect(await client.containers.createRollout("app1", body)).toEqual({
      id: "r1",
      status: "pending",
    });
    expect(fake.last().url).toBe(`${A}/containers/applications/app1/rollouts`);
    expect(await fake.last().request.json()).toEqual(body);
  });

  it("getRollout -> GET /containers/applications/{id}/rollouts/{rolloutId}", async () => {
    const { fake, client } = make({ result: { id: "r1", status: "completed" } });
    expect((await client.containers.getRollout("app1", "r1")).status).toBe("completed");
    expect(fake.last().url).toBe(`${A}/containers/applications/app1/rollouts/r1`);
  });

  it("surfaces a refused call as a CloudflareApiError", async () => {
    const { client } = make({
      status: 403,
      errors: [{ code: 10000, message: "Authentication error" }],
    });
    const error = await client.containers.deleteApplication("app1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).status).toBe(403);
  });
});

describe("durable object namespaces", () => {
  it("listDurableObjectNamespaces -> GET /workers/durable_objects/namespaces", async () => {
    const { fake, client } = make({
      result: [{ id: "ns1", script: "appflare-sandbox", class: "Sandbox" }],
      result_info: { page: 1, total_pages: 1 },
    });
    expect(await client.workers.listDurableObjectNamespaces()).toEqual([
      { id: "ns1", script: "appflare-sandbox", class: "Sandbox" },
    ]);
    expect(fake.last().path).toBe(
      `/client/v4/accounts/${ACCOUNT}/workers/durable_objects/namespaces`,
    );
    expect(fake.last().query.get("per_page")).toBe("1000");
  });

  it("listDurableObjectNamespaces reads every page until a short page or the total", async () => {
    // The list reports total_count but no total_pages (seen live, 2026-10-18).
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `ns${from + i}`, script: "w", class: "C" }));
    const { fake, client } = make((_req, i) =>
      i === 0
        ? { result: page(1000, 0), result_info: { page: 1, per_page: 1000, total_count: 1003 } }
        : { result: page(3, 1000), result_info: { page: 2, per_page: 1000, total_count: 1003 } },
    );
    const all = await client.workers.listDurableObjectNamespaces();
    expect(all).toHaveLength(1003);
    expect(all.at(-1)?.id).toBe("ns1002");
    expect(fake.calls.map((c) => c.query.get("page"))).toEqual(["1", "2"]);

    const exact = make((_req, i) => ({
      result: page(1000, i * 1000),
      result_info: { page: i + 1, per_page: 1000, total_count: 1000 },
    }));
    expect(await exact.client.workers.listDurableObjectNamespaces()).toHaveLength(1000);
    expect(exact.fake.calls).toHaveLength(1);
  });

  it("listDurableObjectNamespaces measures a short page against the per_page answered", async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `ns${from + i}`, script: "w", class: "C" }));
    // A server that answers fewer per page than asked, without a total.
    const capped = make((_req, i) =>
      i === 0
        ? { result: page(500, 0), result_info: { page: 1, per_page: 500 } }
        : { result: page(20, 500), result_info: { page: 2, per_page: 500 } },
    );
    expect(await capped.client.workers.listDurableObjectNamespaces()).toHaveLength(520);
    expect(capped.fake.calls).toHaveLength(2);

    // A total that says more goes on past a short page, and an empty page ends it.
    const short = make((_req, i) =>
      i === 0
        ? { result: page(900, 0), result_info: { page: 1, per_page: 1000, total_count: 950 } }
        : i === 1
          ? { result: page(40, 900), result_info: { page: 2, per_page: 1000, total_count: 950 } }
          : { result: [], result_info: { page: 3, per_page: 1000, total_count: 950 } },
    );
    expect(await short.client.workers.listDurableObjectNamespaces()).toHaveLength(940);
    expect(short.fake.calls.map((c) => c.query.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("listDurableObjectNamespaces throws on an answer without the list", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({
      id: `ns${i}`,
      script: "w",
      class: "C",
    }));
    const { client } = make((_req, i) =>
      i === 0
        ? { result: page, result_info: { page: 1, per_page: 1000, total_count: 1500 } }
        : { result: null, result_info: { page: 2, per_page: 1000, total_count: 1500 } },
    );
    const error = await client.workers.listDurableObjectNamespaces().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("UnreadableDurableObjectNamespaces");
  });

  it("getDurableObjectNamespace -> GET /workers/durable_objects/namespaces/{id}", async () => {
    const { fake, client } = make({
      result: { id: "ns1", script: "appflare-sandbox", class: "Sandbox" },
    });
    expect(await client.workers.getDurableObjectNamespace("ns1")).toEqual({
      id: "ns1",
      script: "appflare-sandbox",
      class: "Sandbox",
    });
    expect(fake.last().path).toBe(
      `/client/v4/accounts/${ACCOUNT}/workers/durable_objects/namespaces/ns1`,
    );
    // A namespace that does not exist (recorded live).
    const gone = make({
      status: 404,
      errors: [{ code: 10066, message: "Durable Object namespace ID 'ns2' not found." }],
    });
    const error = await gone.client.workers
      .getDurableObjectNamespace("ns2")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).status).toBe(404);
  });
});
