import { describe, expect, it } from "vitest";
import { createClient } from "./client";
import { CloudflareApiError } from "./errors";
import { type FakeResponseSpec, makeFakeFetch } from "./fake-fetch";

const TOKEN = "cf-token-DO-NOT-LEAK-123";
const ACCOUNT = "acc-123";
const A = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

function make(spec?: FakeResponseSpec) {
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
});
