import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT, FakeWorld, OTHER_ACCOUNT, ZONE_ID } from "./test/fake-world";
import {
  type Call,
  clearRecords,
  createInstallation,
  installerApp,
  recordRow,
  type StepAnswer,
  stepUntil,
} from "./test/harness";
import { buildRelease } from "./test/release-fixture";

let world: FakeWorld;
let call: Call;

beforeEach(async () => {
  await clearRecords();
  world = new FakeWorld(await buildRelease());
  call = installerApp(world);
});

interface CleanupAnswer {
  status: "running" | "waiting" | "removed" | "failed";
  step: { id: string; label: string };
  done: number;
  total: number;
  message?: string;
}

/** Things in the account the installation did not make, with names close to its own. */
function addNeighbours(): void {
  world.scripts.set("appflare-probe-2", {
    created_on: "2026-01-01T00:00:00Z",
    metadata: {},
    modules: new Map(),
    secrets: new Map(),
    schedules: [],
    workersDev: true,
    previews: false,
  });
  world.d1.push({ uuid: "their-db", name: "appflare-probe-2", created_at: "2026-01-01T00:00:00Z" });
  world.kv.push({ id: "their-kv", title: "appflare-probe-2-kv" });
  world.workflows.set("appflare-probe-2-jobs", {
    script_name: "appflare-probe-2",
    class_name: "J",
  });
  world.domains.push({
    id: "their-domain",
    hostname: "blog.example.com",
    service: "appflare-probe-2",
    zone_id: ZONE_ID,
    zone_name: "example.com",
  });
}

async function cleanUp(id: string, body: Record<string, unknown>): Promise<CleanupAnswer[]> {
  const answers: CleanupAnswer[] = [];
  for (let i = 0; i < 10; i++) {
    const answer = await call<CleanupAnswer>(`installations/${id}/cleanup`, body);
    if (answer.status !== 200) throw new Error(`cleanup answered ${answer.status}: ${answer.text}`);
    expect(answer.subrequests).toBeLessThanOrEqual(40);
    answers.push(answer.body);
    if (answer.body.status !== "running") return answers;
  }
  throw new Error("cleanup did not finish");
}

describe("cleanup", () => {
  it("removes exactly what the installation created, then the record", async () => {
    addNeighbours();
    const created = await createInstallation(call, { hostname: "manage.example.com" });
    await stepUntil(call, created, (a: StepAnswer) => a.status === "deployed");
    expect(world.scripts.size).toBe(2);

    const before = world.calls.length;
    const answers = await cleanUp(created.installationId, { key: created.key });
    expect(answers.at(-1)).toMatchObject({ status: "removed", step: { id: "record" } });
    expect(await recordRow(created.installationId)).toBeNull();

    // Only the neighbours are left.
    expect([...world.scripts.keys()]).toEqual(["appflare-probe-2"]);
    expect(world.d1.map((d) => d.uuid)).toEqual(["their-db"]);
    expect(world.kv.map((n) => n.id)).toEqual(["their-kv"]);
    expect([...world.workflows.keys()]).toEqual(["appflare-probe-2-jobs"]);
    expect(world.domains.map((d) => d.id)).toEqual(["their-domain"]);

    // In an order Cloudflare accepts: domain, Workflow, Worker, then storage.
    const deletes = world.calls
      .slice(before)
      .filter((c) => c.startsWith("DELETE"))
      .map((c) =>
        c.replace(/^DELETE https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+/, ""),
      );
    expect(deletes).toEqual([
      expect.stringMatching(/^\/workers\/domains\//),
      "/workflows/appflare-probe-jobs",
      "/workers/scripts/appflare-probe",
      expect.stringMatching(/^\/storage\/kv\/namespaces\//),
      expect.stringMatching(/^\/d1\/database\//),
    ]);
  });

  it("removes a half-finished installation, including a create whose answer was lost", async () => {
    addNeighbours();
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "database");
    world.loseOnce.add("POST /d1/database");
    await call(`installations/${created.installationId}/step`, { key: created.key });
    expect((await recordRow(created.installationId))?.d1_id).toBeNull();
    expect(world.d1).toHaveLength(2);

    await cleanUp(created.installationId, { key: created.key });
    expect(world.d1.map((d) => d.uuid)).toEqual(["their-db"]);
    expect(world.kv.map((n) => n.id)).toEqual(["their-kv"]);
    expect([...world.scripts.keys()]).toEqual(["appflare-probe-2"]);
  });

  it("leaves a database of its name alone when it was there before the attempt", async () => {
    const created = await createInstallation(call);
    world.d1.push({
      uuid: "older",
      name: "appflare-probe",
      created_at: "2020-01-01T00:00:00Z",
    });
    await cleanUp(created.installationId, { key: created.key });
    expect(world.d1.map((d) => d.uuid)).toEqual(["older"]);
  });

  it("leaves a domain alone that now serves another Worker", async () => {
    const created = await createInstallation(call, { hostname: "manage.example.com" });
    await stepUntil(call, created, (a) => a.step.id === "proof");
    const domain = world.domains[0];
    if (domain === undefined) throw new Error("no domain");
    domain.service = "someone-else";
    await cleanUp(created.installationId, { key: created.key });
    expect(world.domains.map((d) => d.service)).toEqual(["someone-else"]);
  });

  it("takes a token without the key when the token reaches the account", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "worker");
    const answers = await cleanUp(created.installationId, {});
    expect(answers.at(-1)?.status).toBe("removed");
    expect(world.d1).toEqual([]);
    expect(world.kv).toEqual([]);
  });

  it("refuses a token without the key when the token does not reach the account", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "storage");
    world.accounts = [{ id: OTHER_ACCOUNT, name: "Other" }];
    const answer = await call(`installations/${created.installationId}/cleanup`, {});
    expect(answer.status).toBe(403);
    world.accounts = [{ id: ACCOUNT, name: "Probe account" }];
    expect(world.d1).toHaveLength(1);
    expect(await recordRow(created.installationId)).not.toBeNull();
  });

  it("refuses a wrong key", async () => {
    const created = await createInstallation(call);
    const answer = await call(`installations/${created.installationId}/cleanup`, {
      key: "C".repeat(43),
    });
    expect(answer.status).toBe(403);
  });

  it("does not remove a manager that already has an owner", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.status === "deployed");
    world.handoffState = "done";
    const answer = await call(`installations/${created.installationId}/cleanup`, {
      key: created.key,
    });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: { code: "already_set_up" } });
    expect(world.scripts.has("appflare-probe")).toBe(true);
  });

  it("stops the deploy: a removing installation takes no more steps", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "assets");
    world.failOnce.set(`DELETE /storage/kv/namespaces/${world.kv[0]?.id}`, 503);
    const first = await call<CleanupAnswer>(`installations/${created.installationId}/cleanup`, {
      key: created.key,
    });
    expect(first.body.status).toBe("waiting");
    const step = await call(`installations/${created.installationId}/step`, { key: created.key });
    expect(step.status).toBe(409);
    const rest = await cleanUp(created.installationId, { key: created.key });
    expect(rest.at(-1)?.status).toBe("removed");
    expect(world.kv).toEqual([]);
  });
});
