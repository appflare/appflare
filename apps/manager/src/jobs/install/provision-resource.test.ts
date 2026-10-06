import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { ACC, fakeAccount, TOKEN } from "../../test/fake-account";
import { fakeStep } from "../../test/fake-step";
import { INSTALL_ID, seedInstall } from "../../test/seed-install";
import type { JobContext } from "../run-job";
import { createJobSteps } from "../steps";
import { deleteDataResourcesPhase } from "../uninstall";
import type { ResourceBindingPlan } from "./bindings";
import { provisionResourcePhase } from "./phases";

/**
 * Creating one backing resource (check, record the name, create, record the
 * id) against a stateful fake of the Cloudflare API and the local D1: a
 * resource whose id could not be recorded stays known to the install by its
 * name, so the next attempt finishes it and an uninstall deletes it, while a
 * resource of that name the install has no record of is still refused.
 */

const CACHE: ResourceBindingPlan = {
  binding: "CACHE",
  type: "kv_namespace",
  kind: "kv",
  name: "cut-cache",
};
const RECORD_ID = "record KV namespace cut-cache";

function harness(fake: ReturnType<typeof fakeAccount>, failing?: string) {
  const step = fakeStep(failing === undefined ? {} : { failing: [failing] });
  const ctx = {
    params: {} as JobContext["params"],
    step,
    env: { DB: env.DB, CF_API_TOKEN: TOKEN },
    deps: { fetch: fake.fetch },
  } satisfies JobContext;
  const steps = createJobSteps(ctx, "job-1");
  steps.setAccountId(ACC);
  return { steps, step };
}

async function rows() {
  return (
    await env.DB.prepare(
      "SELECT id, kind, binding, name, cf_id, deleted_at FROM resources WHERE install_id = ?1 AND kind = 'kv' ORDER BY rowid",
    )
      .bind(INSTALL_ID)
      .all<{
        id: string;
        kind: string;
        binding: string | null;
        name: string;
        cf_id: string | null;
        deleted_at: number | null;
      }>()
  ).results;
}

const creates = (fake: ReturnType<typeof fakeAccount>) =>
  fake.state.calls.filter((c) => c === "POST /storage/kv/namespaces").length;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall({ status: "updating" });
});

describe("provisioning a resource", () => {
  it("records the name before the create and the id after it", async () => {
    const fake = fakeAccount(null);
    const { steps, step } = harness(fake);
    const made = await provisionResourcePhase(steps, INSTALL_ID, CACHE, {}, []);
    expect(made).toEqual({
      binding: "CACHE",
      type: "kv_namespace",
      name: "cut-cache",
      cfId: "kv-new-1",
    });
    expect(step.names).toEqual([
      "check KV namespace cut-cache",
      "record KV namespace name cut-cache",
      "create KV namespace cut-cache",
      "record KV namespace cut-cache",
    ]);
    expect(await rows()).toEqual([
      {
        id: `${INSTALL_ID}:kv:CACHE`,
        kind: "kv",
        binding: "CACHE",
        name: "cut-cache",
        cf_id: "kv-new-1",
        deleted_at: null,
      },
    ]);
  });

  it("finishes a resource whose id was never recorded on the next attempt, without a second create", async () => {
    const fake = fakeAccount(null);
    const first = harness(fake, RECORD_ID);
    await expect(provisionResourcePhase(first.steps, INSTALL_ID, CACHE, {}, [])).rejects.toThrow(
      /database unavailable/,
    );
    // Created, and known to the install by its name.
    expect(fake.state.kv).toEqual([{ id: "kv-new-1", title: "cut-cache" }]);
    expect(await rows()).toMatchObject([{ name: "cut-cache", cf_id: null, deleted_at: null }]);

    const next = harness(fake);
    const made = await provisionResourcePhase(next.steps, INSTALL_ID, CACHE, {}, []);
    expect(made.cfId).toBe("kv-new-1");
    expect(creates(fake)).toBe(1);
    expect(fake.state.kv).toHaveLength(1);
    expect(await rows()).toMatchObject([
      { name: "cut-cache", cf_id: "kv-new-1", deleted_at: null },
    ]);

    // An uninstall then deletes it by the id now recorded.
    await deleteDataResourcesPhase(
      harness(fake).steps,
      [{ id: `${INSTALL_ID}:kv:CACHE`, kind: "kv", name: "cut-cache", cfId: "kv-new-1" }],
      "uninstall",
    );
    expect(fake.state.kv).toEqual([]);
    expect(fake.state.calls).toContain("DELETE /storage/kv/namespaces/kv-new-1");
  });

  it("lets an uninstall delete a resource recorded by name only, so nothing is left behind", async () => {
    const fake = fakeAccount(null);
    await expect(
      provisionResourcePhase(harness(fake, RECORD_ID).steps, INSTALL_ID, CACHE, {}, []),
    ).rejects.toThrow(/database unavailable/);
    const [row] = await rows();
    expect(row?.cf_id).toBeNull();

    await deleteDataResourcesPhase(
      harness(fake).steps,
      [{ id: `${INSTALL_ID}:kv:CACHE`, kind: "kv", name: "cut-cache", cfId: null }],
      "uninstall",
    );
    // Found by its recorded name and deleted.
    expect(fake.state.kv).toEqual([]);
    expect(fake.state.calls).toContain("DELETE /storage/kv/namespaces/kv-new-1");
    expect((await rows())[0]?.deleted_at).not.toBeNull();
  });

  it("marks a name-only row deleted without a delete when its create never made anything", async () => {
    await env.DB.prepare(
      "INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at) VALUES (?1, ?2, 'kv', 'CACHE', 'cut-cache', NULL, 1)",
    )
      .bind(`${INSTALL_ID}:kv:CACHE`, INSTALL_ID)
      .run();
    const fake = fakeAccount(null);
    await deleteDataResourcesPhase(
      harness(fake).steps,
      [{ id: `${INSTALL_ID}:kv:CACHE`, kind: "kv", name: "cut-cache", cfId: null }],
      "uninstall",
    );
    expect(fake.state.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect((await rows())[0]?.deleted_at).not.toBeNull();
  });

  it("still refuses a resource of that name the install has no record of", async () => {
    const fake = fakeAccount(null, { kv: [{ id: "kv-theirs", title: "cut-cache" }] });
    await expect(
      provisionResourcePhase(harness(fake).steps, INSTALL_ID, CACHE, {}, []),
    ).rejects.toThrow(
      "a KV namespace named cut-cache already exists in this account; Appflare does not adopt existing resources",
    );
    expect(creates(fake)).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("refuses a resource of that name when the install's row of it has an id already", async () => {
    // The row records another namespace's id: the one of that name in the
    // account is not the one this install made.
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES (?1, ?2, 'kv', 'CACHE', 'cut-cache', 'kv-gone', 1)`,
    )
      .bind(`${INSTALL_ID}:kv:CACHE`, INSTALL_ID)
      .run();
    const fake = fakeAccount(null, { kv: [{ id: "kv-theirs", title: "cut-cache" }] });
    await expect(
      provisionResourcePhase(harness(fake).steps, INSTALL_ID, CACHE, {}, []),
    ).rejects.toThrow(
      "a KV namespace named cut-cache already exists in this account; Appflare does not adopt existing resources",
    );
    expect(creates(fake)).toBe(0);
    expect(await rows()).toMatchObject([{ cf_id: "kv-gone", deleted_at: null }]);
  });

  it("releases the name when Cloudflare refuses the create, so it is never taken up later", async () => {
    const fake = fakeAccount(null);
    const refusing = async (input: string, init?: RequestInit) =>
      new Request(input, init).method === "POST" && input.endsWith("/storage/kv/namespaces")
        ? Response.json(
            { success: false, errors: [{ code: 10014, message: "refused" }] },
            { status: 400 },
          )
        : fake.fetch(input, init);
    const step = fakeStep();
    const steps = createJobSteps(
      {
        params: {} as JobContext["params"],
        step,
        env: { DB: env.DB, CF_API_TOKEN: TOKEN },
        deps: { fetch: refusing },
      },
      "job-1",
    );
    steps.setAccountId(ACC);
    await expect(provisionResourcePhase(steps, INSTALL_ID, CACHE, {}, [])).rejects.toThrow(
      /refused/,
    );
    expect((await rows())[0]?.deleted_at).not.toBeNull();

    // A namespace of that name made elsewhere afterwards is not this install's.
    fake.state.kv.push({ id: "kv-theirs", title: "cut-cache" });
    await expect(
      provisionResourcePhase(harness(fake).steps, INSTALL_ID, CACHE, {}, []),
    ).rejects.toThrow(/does not adopt existing resources/);
  });
});
