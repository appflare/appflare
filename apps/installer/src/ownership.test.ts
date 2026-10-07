import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { Budget } from "./budget";
import { cloudflareFor } from "./cloudflare";
import { readConfig } from "./config";
import { runStep } from "./deploy/run";
import type { InstallerError } from "./http";
import { createdByAttempt, kvByAttempt } from "./ownership";
import { createDb, getRecord, LEASE_MS } from "./records";
import { ACCOUNT, type FakeScript, FakeWorld, TOKEN } from "./test/fake-world";
import {
  type Call,
  type Created,
  clearRecords,
  createInstallation,
  installerApp,
  recordRow,
  type StepAnswer,
  stepUntil,
} from "./test/harness";
import { buildRelease } from "./test/release-fixture";

/**
 * Only what an installation created is ever adopted or removed: a resource
 * that merely has its name, made by something else (the command-line
 * installer, a person in the dashboard) after a create of the installation
 * failed, is left alone by the deploy steps and by cleanup.
 */

let world: FakeWorld;
let call: Call;

beforeEach(async () => {
  await clearRecords();
  world = new FakeWorld(await buildRelease());
  call = installerApp(world);
});

const MINUTE = 60_000;

function theirScript(createdOn: string): FakeScript {
  return {
    created_on: createdOn,
    metadata: { theirs: true },
    modules: new Map(),
    secrets: new Map(),
    schedules: [],
    workersDev: false,
    previews: false,
  };
}

async function step(created: Created, app: Call = call): Promise<StepAnswer> {
  const answer = await app<StepAnswer>(`installations/${created.installationId}/step`, {
    key: created.key,
  });
  if (answer.status !== 200) throw new Error(`step answered ${answer.status}: ${answer.text}`);
  return answer.body;
}

async function removeAll(created: Created, app: Call = call) {
  for (let i = 0; i < 10; i++) {
    const answer = await app<{ status: string; message?: string }>(
      `installations/${created.installationId}/cleanup`,
      { key: created.key },
    );
    if (answer.body.status !== "running") return answer.body;
  }
  throw new Error("cleanup did not finish");
}

describe("a create Cloudflare refused, then the same name made by something else", () => {
  it("D1: the step refuses it and cleanup leaves it", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "database");
    world.failOnce.set("POST /d1/database", 403);
    expect(await step(created)).toMatchObject({ status: "failed", step: { id: "database" } });
    expect((await recordRow(created.installationId))?.d1_attempt_at).toBeNull();

    // Moments later, create-appflare makes its own database of that name.
    world.d1.push({ uuid: "cli-db", name: "appflare-probe", created_at: new Date().toISOString() });
    const refused = await step(created);
    expect(refused).toMatchObject({ status: "failed", step: { id: "database" } });
    expect(refused.message).toMatch(/by something else/);

    expect((await removeAll(created)).status).toBe("removed");
    expect(world.d1.map((d) => d.uuid)).toEqual(["cli-db"]);
  });

  it("KV: the step refuses it and cleanup leaves it", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "storage");
    world.failOnce.set("POST /storage/kv/namespaces", 403);
    expect(await step(created)).toMatchObject({ status: "failed", step: { id: "storage" } });
    expect((await recordRow(created.installationId))?.kv_attempt_at).toBeNull();

    world.kv.push({ id: "cli-kv", title: "appflare-probe-kv" });
    expect(await step(created)).toMatchObject({ status: "failed", step: { id: "storage" } });

    await removeAll(created);
    expect(world.kv.map((n) => n.id)).toEqual(["cli-kv"]);
    expect(world.d1).toEqual([]);
  });

  it("Worker: the step refuses to replace it and cleanup leaves it", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "worker");
    world.failOnce.set("PUT /workers/scripts/appflare-probe", 400);
    expect(await step(created)).toMatchObject({ status: "failed", step: { id: "worker" } });
    expect((await recordRow(created.installationId))?.worker_attempt_at).toBeNull();

    world.scripts.set("appflare-probe", theirScript(new Date().toISOString()));
    expect(await step(created)).toMatchObject({ status: "failed", step: { id: "worker" } });
    expect(world.scripts.get("appflare-probe")?.metadata).toEqual({ theirs: true });

    await removeAll(created);
    expect(world.scripts.get("appflare-probe")?.metadata).toEqual({ theirs: true });
  });
});

describe("a create whose answer never came, then the same name made much later", () => {
  it("D1 and Worker: made after the attempt's window, they are not the installation's", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "database");
    world.failOnce.set("POST /d1/database", 503);
    expect(await step(created)).toMatchObject({ status: "waiting", step: { id: "database" } });
    const row = await recordRow(created.installationId);
    expect(row?.d1_attempt_at).not.toBeNull();

    const later = new Date(Number(row?.d1_attempt_at) + 10 * MINUTE).toISOString();
    world.d1.push({ uuid: "later-db", name: "appflare-probe", created_at: later });
    expect(await step(created)).toMatchObject({ status: "failed", step: { id: "database" } });

    const removed = await removeAll(created);
    expect(removed.status).toBe("removed");
    expect(removed.message).toMatch(/Left in place: the D1 database "appflare-probe"/);
    expect(world.d1.map((d) => d.uuid)).toEqual(["later-db"]);
  });

  it("Worker: a lost upload adopts the Worker made in its window, never one made later", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "worker");
    world.failOnce.set("PUT /workers/scripts/appflare-probe", 503);
    expect(await step(created)).toMatchObject({ status: "waiting", step: { id: "worker" } });
    const attempt = Number((await recordRow(created.installationId))?.worker_attempt_at);
    world.scripts.set(
      "appflare-probe",
      theirScript(new Date(attempt + LEASE_MS + 5 * MINUTE).toISOString()),
    );
    expect(await step(created)).toMatchObject({ status: "failed", step: { id: "worker" } });
    await removeAll(created);
    expect(world.scripts.get("appflare-probe")?.metadata).toEqual({ theirs: true });
  });

  it("KV: found long after the attempt, or more than one, it is not the installation's", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "storage");
    world.failOnce.set("POST /storage/kv/namespaces", 503);
    expect(await step(created)).toMatchObject({ status: "waiting", step: { id: "storage" } });
    world.kv.push({ id: "theirs", title: "appflare-probe-kv" });

    const muchLater = installerApp(world, { now: () => Date.now() + 30 * MINUTE });
    const refused = await step(created, muchLater);
    expect(refused).toMatchObject({ status: "failed", step: { id: "storage" } });
    expect(refused.message).toMatch(/cannot tell whether it made it/);

    const removed = await removeAll(created, muchLater);
    expect(removed.message).toMatch(/Left in place: the KV namespace "appflare-probe-kv"/);
    expect(world.kv.map((n) => n.id)).toEqual(["theirs"]);
  });

  it("KV: two namespaces with the title are never adopted, even right away", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "storage");
    world.failOnce.set("POST /storage/kv/namespaces", 503);
    await step(created);
    world.kv.push(
      { id: "one", title: "appflare-probe-kv" },
      { id: "two", title: "appflare-probe-kv" },
    );
    expect(await step(created)).toMatchObject({ status: "failed", step: { id: "storage" } });
    await removeAll(created);
    expect(world.kv.map((n) => n.id)).toEqual(["one", "two"]);
  });
});

describe("ownership windows", () => {
  it("bounds a creation time to the attempt's request, with clock leeway", () => {
    const at = Date.parse("2026-10-06T10:00:00Z");
    expect(createdByAttempt("2026-10-06T10:00:05Z", at)).toBe(true);
    expect(createdByAttempt("2026-10-06T09:59:45Z", at)).toBe(true);
    expect(createdByAttempt("2026-10-06T09:59:00Z", at)).toBe(false);
    expect(createdByAttempt("2026-10-06T10:05:00Z", at)).toBe(false);
    expect(createdByAttempt("2026-10-06T10:00:05Z", null)).toBe(false);
    expect(kvByAttempt(1, at, at + MINUTE)).toBe(true);
    expect(kvByAttempt(1, at, at + 30 * MINUTE)).toBe(false);
    expect(kvByAttempt(2, at, at + MINUTE)).toBe(false);
    expect(kvByAttempt(1, null, at)).toBe(false);
  });
});

describe("a step and a removal at once", () => {
  it("a step that gets the record after its removal started does nothing", async () => {
    const created = await createInstallation(call);
    await env.DB.prepare("UPDATE installations SET status = 'removing' WHERE id = ?1")
      .bind(created.installationId)
      .run();
    const db = createDb(env.DB);
    const before = world.calls.length;
    const budget = new Budget();
    await expect(
      runStep(await getRecord(db, created.installationId), {
        db,
        api: cloudflareFor(TOKEN, world.fetch, ACCOUNT),
        fetch: world.fetch,
        budget,
        config: readConfig(env),
        now: Date.now(),
      }),
    ).rejects.toMatchObject({ status: 409, code: "removing" } satisfies Partial<InstallerError>);
    expect(world.calls.length).toBe(before);
    expect((await recordRow(created.installationId))?.step).toBe("release");
  });
});
