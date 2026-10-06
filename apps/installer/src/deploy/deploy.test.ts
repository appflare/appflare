import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT, FakeWorld, SUBDOMAIN, TOKEN, ZONE_ID } from "../test/fake-world";
import {
  type Call,
  clearRecords,
  createInstallation,
  HANDOFF_HASH,
  installerApp,
  recordRow,
  type StepAnswer,
  stepUntil,
} from "../test/harness";
import { buildRelease } from "../test/release-fixture";

let world: FakeWorld;
let call: Call;

beforeEach(async () => {
  await clearRecords();
  world = new FakeWorld(await buildRelease());
  call = installerApp(world);
});

const deployed = (a: StepAnswer) => a.status === "deployed";

describe("deploy to workers.dev", () => {
  it("runs every step, one bounded unit per request, then waits for the proof", async () => {
    const created = await createInstallation(call);
    expect(created.address).toBe(`https://appflare-probe.${SUBDOMAIN}.workers.dev`);
    expect(created.release).toEqual({ version: "0.4.0" });
    world.addressAnswers.set(`appflare-probe.${SUBDOMAIN}.workers.dev`, [
      "tls",
      "404-1042",
      "unrelated-200",
      "redirect",
      "wrong-proof",
    ]);

    const { answers } = await stepUntil(call, created, deployed);
    const ids = answers.map((a) => a.step.id);
    expect(ids).toEqual([
      "database",
      "storage",
      "assets",
      "worker",
      "workflow",
      "schedules",
      "secret",
      "workers-dev",
      "proof",
      "proof",
      "proof",
      "proof",
      "proof",
      "proof",
      "proof",
    ]);
    // Every propagation answer is "waiting", never success, and asks for a later retry.
    const waits = answers.filter((a) => a.status === "waiting");
    expect(waits).toHaveLength(5);
    for (const wait of waits) {
      expect(wait.retryAfterMs).toBeGreaterThan(0);
      expect(wait.message).toMatch(/address/);
    }
    expect(answers.at(-1)).toMatchObject({ status: "deployed", done: 10, total: 10 });

    // What exists now: exactly the installation's resources.
    expect(world.d1.map((d) => d.name)).toEqual(["appflare-probe"]);
    expect(world.kv.map((n) => n.title)).toEqual(["appflare-probe-kv"]);
    expect([...world.workflows]).toEqual([
      ["appflare-probe-jobs", { script_name: "appflare-probe", class_name: "JobWorkflow" }],
    ]);
    const script = world.scripts.get("appflare-probe");
    expect(script?.schedules).toEqual(["*/30 * * * *"]);
    expect(script?.workersDev).toBe(true);
    expect(script?.previews).toBe(true);
    expect([...(script?.secrets.keys() ?? [])]).toEqual(["APPFLARE_HANDOFF"]);
    expect(script?.secrets.get("APPFLARE_HANDOFF")).toBe(`v1.${HANDOFF_HASH}`);
    expect(new TextDecoder().decode(script?.modules.get("index.js"))).toBe(
      world.release.moduleText,
    );
    // Every static file is stored (the fake checks each one's hash against its bytes).
    expect([...world.storedAssets].sort()).toEqual(
      world.release.manifest.assets.files.map((f) => f.hash).sort(),
    );
  });

  it("uploads the manager with the release's settings, the installer's vars, and no SELF", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "workflow");
    const metadata = world.scripts.get("appflare-probe")?.metadata as Record<string, unknown>;
    const bindings = metadata.bindings as Array<Record<string, unknown>>;
    const byName = new Map(bindings.map((b) => [b.name, b]));
    expect(metadata.main_module).toBe("index.js");
    expect(metadata.compatibility_date).toBe("2026-09-21");
    expect(metadata.compatibility_flags).toEqual(["nodejs_compat", "global_fetch_strictly_public"]);
    expect(byName.get("DB")).toEqual({ type: "d1", name: "DB", id: world.d1[0]?.uuid });
    expect(byName.get("KV")).toEqual({
      type: "kv_namespace",
      name: "KV",
      namespace_id: world.kv[0]?.id,
    });
    expect(byName.get("JOBS")).toEqual({
      type: "workflow",
      name: "JOBS",
      workflow_name: "appflare-probe-jobs",
      class_name: "JobWorkflow",
    });
    expect(byName.get("CF_VERSION_METADATA")).toEqual({
      type: "version_metadata",
      name: "CF_VERSION_METADATA",
    });
    expect(byName.get("APPFLARE_VERSION")).toMatchObject({ type: "plain_text", text: "0.4.0" });
    expect(byName.get("APPFLARE_INSTALLER_ORIGIN")).toEqual({
      type: "plain_text",
      name: "APPFLARE_INSTALLER_ORIGIN",
      text: "https://appflare-docs.appflare-dev.workers.dev",
    });
    expect(byName.get("APPFLARE_INSTALL_SOURCE")).toEqual({
      type: "plain_text",
      name: "APPFLARE_INSTALL_SOURCE",
      text: "browser",
    });
    expect(byName.get("APPFLARE_HANDOFF")).toEqual({
      type: "secret_text",
      name: "APPFLARE_HANDOFF",
      text: `v1.${HANDOFF_HASH}`,
    });
    expect(byName.get("ASSETS")).toEqual({ type: "assets", name: "ASSETS" });
    expect(byName.has("SELF")).toBe(false);
    expect(bindings.filter((b) => b.type === "secret_text")).toHaveLength(1);
    expect(metadata.keep_bindings).toEqual(["secret_text", "secret_key"]);
    expect(metadata.observability).toEqual({ enabled: true });
    expect((metadata.assets as { config: unknown }).config).toEqual(
      world.release.manifest.assets.config,
    );
  });

  it("names the Workflow after the release's when the default name is used", async () => {
    const created = await createInstallation(call, { workerName: "appflare" });
    await stepUntil(call, created, (a) => a.step.id === "schedules");
    expect([...world.workflows.keys()]).toEqual(["appflare-jobs"]);
  });
});

describe("deploy to a custom domain", () => {
  it("attaches the hostname and proves the manager answers there", async () => {
    const created = await createInstallation(call, { hostname: "Manage.Example.com" });
    expect(created.address).toBe("https://manage.example.com");
    world.addressAnswers.set("manage.example.com", ["tls", "404-1042"]);
    const { answers, last } = await stepUntil(call, created, deployed);
    expect(answers.map((a) => a.step.id)).toContain("domain");
    expect(last).toMatchObject({ status: "deployed", done: 11, total: 11 });
    expect(world.domains).toEqual([
      expect.objectContaining({
        hostname: "manage.example.com",
        service: "appflare-probe",
        zone_id: ZONE_ID,
      }),
    ]);
    expect((await recordRow(created.installationId))?.domain_id).toBe(world.domains[0]?.id);
  });

  it("refuses at the domain step when the hostname gained DNS records, and attaches nothing", async () => {
    const created = await createInstallation(call, { hostname: "manage.example.com" });
    world.dns.push({
      zone_id: ZONE_ID,
      id: "r1",
      name: "manage.example.com",
      type: "A",
      content: "192.0.2.1",
    });
    const { last } = await stepUntil(call, created, (a) => a.status === "failed");
    expect(last.step.id).toBe("domain");
    expect(last.message).toMatch(/already has DNS records/);
    expect(world.domains).toEqual([]);
    // Fixing it and asking again continues from the same step.
    world.dns = [];
    const again = await stepUntil(call, created, (a) => a.step.id === "proof");
    expect(again.answers[0]?.status).toBe("running");
    expect(world.domains).toHaveLength(1);
  });

  it("refuses at the domain step when a route catches the hostname", async () => {
    const created = await createInstallation(call, { hostname: "manage.example.com" });
    world.routes.push({ zone_id: ZONE_ID, id: "rt", pattern: "*.example.com/*", script: "other" });
    const { last } = await stepUntil(call, created, (a) => a.status === "failed");
    expect(last.message).toMatch(/through the route/);
    expect(world.domains).toEqual([]);
  });
});

describe("resuming", () => {
  it("adopts a database whose create answer was lost, never making a second one", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "database");
    world.loseOnce.add("POST /d1/database");
    const lost = await call<StepAnswer>(`installations/${created.installationId}/step`, {
      key: created.key,
    });
    expect(lost.body).toMatchObject({ status: "waiting", step: { id: "database" } });
    expect(world.d1).toHaveLength(1);
    await stepUntil(call, created, (a) => a.step.id === "storage");
    expect(world.d1).toHaveLength(1);
    expect((await recordRow(created.installationId))?.d1_id).toBe(world.d1[0]?.uuid);
  });

  it("adopts a Worker and a KV namespace whose create answers were lost", async () => {
    const created = await createInstallation(call);
    world.loseOnce.add("POST /storage/kv/namespaces");
    world.loseOnce.add("PUT /workers/scripts/appflare-probe");
    await stepUntil(call, created, (a) => a.step.id === "workflow");
    expect(world.kv).toHaveLength(1);
    const row = await recordRow(created.installationId);
    expect(row?.kv_id).toBe(world.kv[0]?.id);
    expect(row?.worker_created).toBe(1);
  });

  it("refuses a database of its name that someone else made after it started", async () => {
    const created = await createInstallation(call);
    world.d1.push({ uuid: "theirs", name: "appflare-probe", created_at: new Date().toISOString() });
    const { last } = await stepUntil(call, created, (a) => a.status === "failed");
    expect(last.step.id).toBe("database");
    expect(last.message).toMatch(/created in this Cloudflare account by something else/);
    expect(world.d1).toHaveLength(1);
    expect((await recordRow(created.installationId))?.d1_id).toBeNull();
  });

  it("refuses to replace a Worker of its name that someone else made", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "worker");
    world.scripts.set("appflare-probe", {
      created_on: new Date().toISOString(),
      metadata: { theirs: true },
      modules: new Map(),
      secrets: new Map(),
      schedules: [],
      workersDev: false,
      previews: false,
    });
    const { last } = await stepUntil(call, created, (a) => a.status === "failed");
    expect(last.step.id).toBe("worker");
    expect(world.scripts.get("appflare-probe")?.metadata).toEqual({ theirs: true });
  });

  it("waits and carries on after Cloudflare is busy", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "storage");
    world.failOnce.set("POST /storage/kv/namespaces", 503);
    const busy = await call<StepAnswer>(`installations/${created.installationId}/step`, {
      key: created.key,
    });
    expect(busy.body).toMatchObject({ status: "waiting", step: { id: "storage" } });
    expect(busy.body.retryAfterMs).toBeGreaterThan(0);
    await stepUntil(call, created, (a) => a.step.id === "assets");
    expect(world.kv).toHaveLength(1);
  });

  it("answers 401 and changes nothing when Cloudflare no longer accepts the token", async () => {
    const created = await createInstallation(call);
    world.acceptedToken = "a-fresh-token-the-browser-has-not-got-yet";
    await stepUntil(call, created, (a) => a.step.id === "database");
    const before = await recordRow(created.installationId);
    const answer = await call(`installations/${created.installationId}/step`, { key: created.key });
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({
      error: { code: "cloudflare_auth", message: expect.stringMatching(/Connect your Cloudflare/) },
    });
    const after = await recordRow(created.installationId);
    expect(after?.step).toBe(before?.step);
    expect(after?.d1_id).toBeNull();
  });

  it("lets one request work on a record at a time", async () => {
    const created = await createInstallation(call);
    await recordLease(created.installationId);
    const answer = await call<StepAnswer>(`installations/${created.installationId}/step`, {
      key: created.key,
    });
    expect(answer.body).toMatchObject({ status: "waiting", retryAfterMs: 2000 });
    expect(answer.subrequests).toBe(0);
  });

  it("stops before uploading anything when a release file does not match its signature", async () => {
    const created = await createInstallation(call);
    const tampered = world.release.zip.slice();
    const at = world.release.manifest.assets.files[0]?.offset ?? 0;
    tampered[at] = (tampered[at] ?? 0) ^ 1;
    world.zipOverride = tampered;
    const answer = await call<StepAnswer>(`installations/${created.installationId}/step`, {
      key: created.key,
    });
    expect(answer.body).toMatchObject({ status: "failed", step: { id: "release" } });
    expect(answer.body.message).toMatch(/do not match their signature/);
    expect(world.d1).toEqual([]);
    expect(world.scripts.size).toBe(0);
  });

  it("refuses a wrong key without touching the record", async () => {
    const created = await createInstallation(call);
    const answer = await call(`installations/${created.installationId}/step`, {
      key: "A".repeat(43),
    });
    expect(answer.status).toBe(403);
    expect((await recordRow(created.installationId))?.step).toBe("release");
  });
});

describe("asset upload in parts", () => {
  it("uploads many files over several requests, each within the budget", async () => {
    world = new FakeWorld(await buildRelease({ assetCount: 80 }));
    world.singleAssetUploads = true;
    world.bucketSize = 80;
    call = installerApp(world);
    const created = await createInstallation(call);
    const { answers } = await stepUntil(call, created, (a) => a.step.id === "workflow");
    const assetRequests = answers.filter((a) => a.step.id === "assets");
    expect(assetRequests.length).toBeGreaterThan(2);
    expect(world.storedAssets.size).toBe(80);
    expect(world.scripts.has("appflare-probe")).toBe(true);
  });
});

describe("cron trigger limit", () => {
  it("carries on with a plain warning when the account has no cron trigger left", async () => {
    world.cronLimit = true;
    const created = await createInstallation(call);
    const { answers } = await stepUntil(call, created, (a) => a.step.id === "secret");
    expect(answers.at(-1)?.message).toMatch(/scheduled trigger/);
  });
});

async function recordLease(id: string): Promise<void> {
  const { env } = await import("cloudflare:workers");
  await env.DB.prepare(
    "UPDATE installations SET lease_owner = 'other', lease_until = ?1 WHERE id = ?2",
  )
    .bind(Date.now() + 60_000, id)
    .run();
}

describe("handoff secret", () => {
  const NEW_HASH = "f".repeat(64);

  it("before the upload only records the new hash, which the upload then uses", async () => {
    const created = await createInstallation(call);
    const answer = await call(`installations/${created.installationId}/handoff-secret`, {
      key: created.key,
      handoffHash: NEW_HASH,
    });
    expect(answer.body).toEqual({ ok: true });
    expect(answer.subrequests).toBe(0);
    await stepUntil(call, created, (a) => a.step.id === "workflow");
    expect(world.scripts.get("appflare-probe")?.secrets.get("APPFLARE_HANDOFF")).toBe(
      `v1.${NEW_HASH}`,
    );
  });

  it("replaces the manager's secret while it waits for its connection", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, deployed);
    const answer = await call(`installations/${created.installationId}/handoff-secret`, {
      key: created.key,
      handoffHash: NEW_HASH,
    });
    expect(answer.body).toEqual({ ok: true });
    expect(world.scripts.get("appflare-probe")?.secrets.get("APPFLARE_HANDOFF")).toBe(
      `v1.${NEW_HASH}`,
    );
    expect((await recordRow(created.installationId))?.handoff_hash).toBe(NEW_HASH);
  });

  it("is refused once the manager has received its connection", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, deployed);
    world.handoffState = "received";
    const answer = await call(`installations/${created.installationId}/handoff-secret`, {
      key: created.key,
      handoffHash: NEW_HASH,
    });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: { code: "handoff_received" } });
    expect(world.scripts.get("appflare-probe")?.secrets.get("APPFLARE_HANDOFF")).toBe(
      `v1.${HANDOFF_HASH}`,
    );
  });

  it("is refused while the manager cannot be asked", async () => {
    const created = await createInstallation(call);
    await stepUntil(call, created, (a) => a.step.id === "workers-dev");
    const answer = await call(`installations/${created.installationId}/handoff-secret`, {
      key: created.key,
      handoffHash: NEW_HASH,
    });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: { code: "not_reachable" } });
  });
});

describe("accounts the token cannot reach", () => {
  it("fails the step instead of touching another account", async () => {
    const created = await createInstallation(call);
    world.accounts = [{ id: "ffffffffffffffffffffffffffffffff", name: "elsewhere" }];
    const answer = await call<StepAnswer>(`installations/${created.installationId}/step`, {
      key: created.key,
    });
    // The release step reads only GitHub; the database step meets the refusal.
    expect(answer.body.status).toBe("running");
    const refused = await call<StepAnswer>(`installations/${created.installationId}/step`, {
      key: created.key,
    });
    expect(refused.body).toMatchObject({ status: "failed", step: { id: "database" } });
    expect(world.d1).toEqual([]);
    expect(TOKEN).not.toBe("");
    expect(ACCOUNT).not.toBe("");
  });
});
