import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT, DEV_RELEASE_URL, FakeWorld, OTHER_ACCOUNT, ZONE_ID } from "./test/fake-world";
import {
  type Call,
  clearRecords,
  createInstallation,
  HANDOFF_HASH,
  installerApp,
  recordRow,
  sha256Hex,
} from "./test/harness";
import { buildRelease, signingKeyPair } from "./test/release-fixture";

let world: FakeWorld;
let call: Call;

beforeEach(async () => {
  await clearRecords();
  world = new FakeWorld(await buildRelease());
  call = installerApp(world);
});

describe("routing and requests", () => {
  it("answers only POST under /api/install/", async () => {
    expect((await call("accounts", {}, { method: "GET" })).status).toBe(405);
    expect((await call("nothing-here")).status).toBe(404);
    expect((await call("installations/not-an-id/step", { key: "x" })).status).toBe(404);
  });

  it("asks for a Cloudflare connection when there is no bearer token", async () => {
    const answer = await call("accounts", {}, { token: null });
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({
      error: {
        code: "unauthorized",
        message: "Connect your Cloudflare account first, then try again.",
      },
    });
    expect(answer.subrequests).toBe(0);
  });

  it("names the bad field without repeating its value", async () => {
    const answer = await call("zones", { accountId: "not-an-account-<script>" });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({
      error: { code: "invalid_request", message: "The request has an invalid accountId." },
    });
    expect(answer.text).not.toContain("<script>");
  });
});

describe("configuration", () => {
  it("refuses every request when a development override is set in production", async () => {
    const prod = installerApp(world, {
      env: {
        INSTALLER_ENV: "production",
        INSTALLER_ORIGIN: "https://appflare.dev",
        DEV_RELEASE_URL,
      },
    });
    const answer = await prod("accounts");
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ error: { code: "unavailable" } });
    expect(answer.subrequests).toBe(0);
  });

  it("refuses every request without an environment", async () => {
    const answer = await installerApp(world, { env: { INSTALLER_ENV: "" } })("accounts");
    expect(answer.status).toBe(503);
  });
});

describe("POST accounts", () => {
  it("lists the token's accounts with their workers.dev subdomain", async () => {
    world.accounts.push({ id: OTHER_ACCOUNT, name: "Second" });
    const answer = await call("accounts");
    expect(answer.body).toEqual({
      accounts: [
        { id: ACCOUNT, name: "Probe account", workersDevSubdomain: "probe-sub" },
        { id: OTHER_ACCOUNT, name: "Second", workersDevSubdomain: "probe-sub" },
      ],
    });
  });

  it("reports an account without a workers.dev subdomain as null", async () => {
    world.subdomain = null;
    const answer = await call("accounts");
    expect(answer.body).toEqual({
      accounts: [{ id: ACCOUNT, name: "Probe account", workersDevSubdomain: null }],
    });
  });

  it("answers 401 when Cloudflare does not accept the token", async () => {
    world.acceptedToken = "another-token-entirely-0000";
    const answer = await call("accounts");
    expect(answer.status).toBe(401);
    expect(answer.body).toMatchObject({ error: { code: "cloudflare_auth" } });
  });
});

describe("POST zones", () => {
  it("lists the account's active zones only", async () => {
    const answer = await call("zones", { accountId: ACCOUNT });
    expect(answer.body).toEqual({ zones: [{ id: ZONE_ID, name: "example.com" }] });
  });
});

describe("POST check", () => {
  const check = (workerName: string, hostname: string | null = null) =>
    call("check", { accountId: ACCOUNT, workerName, hostname });

  it("finds a free name and hostname", async () => {
    expect((await check("appflare-probe", "app.example.com")).body).toEqual({
      workerName: "free",
      hostname: "free",
    });
  });

  it("calls a name taken by a Worker, a database, a KV namespace or a Workflow", async () => {
    world.scripts.set("w1", {
      created_on: "2026-01-01T00:00:00Z",
      metadata: {},
      modules: new Map(),
      secrets: new Map(),
      schedules: [],
      workersDev: false,
      previews: false,
    });
    world.d1.push({ uuid: "d", name: "d1-name", created_at: "2026-01-01T00:00:00Z" });
    world.kv.push({ id: "k", title: "kv-name-kv" });
    world.workflows.set("wf-name-jobs", { script_name: "x", class_name: "Y" });
    for (const name of ["w1", "d1-name", "kv-name", "wf-name"]) {
      expect((await check(name)).body).toEqual({ workerName: "taken", hostname: null });
    }
    expect((await check("other")).body).toEqual({ workerName: "free", hostname: null });
  });

  it("calls a name taken by an unfinished installation", async () => {
    await createInstallation(call);
    expect((await check("appflare-probe")).body).toMatchObject({ workerName: "taken" });
  });

  it("names DNS, Worker and route conflicts of a hostname", async () => {
    world.dns.push({
      zone_id: ZONE_ID,
      id: "r",
      name: "a.example.com",
      type: "CNAME",
      content: "x.test",
    });
    world.domains.push({
      id: "d",
      hostname: "b.example.com",
      service: "blog",
      zone_id: ZONE_ID,
      zone_name: "example.com",
    });
    world.routes.push({
      zone_id: ZONE_ID,
      id: "rt",
      pattern: "c.example.com/api/*",
      script: "api",
    });
    world.routes.push({ zone_id: ZONE_ID, id: "rt2", pattern: "d.example.com/*" });
    expect((await check("n", "a.example.com")).body).toEqual({
      workerName: "free",
      hostname: { conflict: "dns", detail: expect.stringContaining("CNAME x.test") },
    });
    expect((await check("n", "b.example.com")).body).toMatchObject({
      hostname: { conflict: "worker", detail: expect.stringContaining('"blog"') },
    });
    expect((await check("n", "c.example.com")).body).toMatchObject({
      hostname: { conflict: "route", detail: expect.stringContaining('"api"') },
    });
    // A route without a Worker excludes requests from routes; it serves nothing.
    expect((await check("n", "d.example.com")).body).toMatchObject({ hostname: "free" });
  });

  it("reports a wildcard record that answers for the hostname as a DNS conflict", async () => {
    world.dns.push({
      zone_id: ZONE_ID,
      id: "w",
      name: "*.example.com",
      type: "A",
      content: "192.0.2.7",
    });
    expect((await check("n", "app.example.com")).body).toEqual({
      workerName: "free",
      hostname: {
        conflict: "dns",
        detail: expect.stringContaining(
          "The wildcard DNS record *.example.com (A 192.0.2.7) covers app.example.com",
        ),
      },
    });
    // The zone's own apex is not covered by its wildcard.
    expect((await check("n", "example.com")).body).toMatchObject({ hostname: "free" });
  });

  it("finds the hostname's zone by its parent names, never by listing every zone", async () => {
    world.zones.push({
      id: "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
      name: "dev.example.com",
      status: "active",
      account: { id: ACCOUNT },
    });
    world.zoneLookups = [];
    const answer = await call("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: "a.b.dev.example.com",
      handoffHash: HANDOFF_HASH,
    });
    expect(answer.status).toBe(200);
    expect(world.zoneLookups).toEqual([
      "a.b.dev.example.com",
      "b.dev.example.com",
      "dev.example.com",
    ]);
    const row = await recordRow((answer.body as { installationId: string }).installationId);
    expect(row?.zone_id).toBe("c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2");
    expect(answer.subrequests).toBeLessThanOrEqual(40);
  });

  it("refuses a hostname outside the account's active domains", async () => {
    const outside = await check("n", "app.elsewhere.test");
    expect(outside.status).toBe(400);
    expect(outside.body).toMatchObject({ error: { code: "hostname_not_in_account" } });
    const pending = await check("n", "app.pending.example");
    expect(pending.body).toMatchObject({ error: { code: "hostname_not_in_account" } });
    const invalid = await check("n", "https://app.example.com/x");
    expect(invalid.body).toMatchObject({ error: { code: "invalid_hostname" } });
  });
});

describe("POST installations", () => {
  it("records the installation with the key's hash and returns the key once", async () => {
    const created = await createInstallation(call);
    expect(created).toEqual({
      installationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      release: { version: "0.4.0" },
      address: "https://appflare-probe.probe-sub.workers.dev",
    });
    const row = await recordRow(created.installationId);
    expect(row).toMatchObject({
      account_id: ACCOUNT,
      worker_name: "appflare-probe",
      hostname: null,
      status: "running",
      step: "release",
      key_hash: await sha256Hex(created.key),
      handoff_hash: HANDOFF_HASH,
      d1_name: "appflare-probe",
      kv_title: "appflare-probe-kv",
      workflow_name: "appflare-probe-jobs",
      release_version: "0.4.0",
      release_digest: await sha256Hex(new TextDecoder().decode(world.release.manifestBytes)),
      release_zip_url:
        "https://github.com/appflare/appflare/releases/download/manager%400.4.0/appflare-0.4.0.zip",
    });
    expect(JSON.stringify(row)).not.toContain(created.key);
  });

  it("stays within the subrequest budget", async () => {
    const answer = await call("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: "app.example.com",
      handoffHash: HANDOFF_HASH,
    });
    expect(answer.status).toBe(200);
    expect(answer.subrequests).toBeLessThanOrEqual(40);
  });

  it("refuses a taken name or hostname, creating nothing", async () => {
    world.kv.push({ id: "k", title: "appflare-probe-kv" });
    const name = await call("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: null,
      handoffHash: HANDOFF_HASH,
    });
    expect(name.status).toBe(409);
    expect(name.body).toMatchObject({
      error: {
        code: "name_taken",
        message: expect.stringContaining('KV namespace named "appflare-probe-kv"'),
      },
    });
    world.dns.push({
      zone_id: ZONE_ID,
      id: "r",
      name: "app.example.com",
      type: "A",
      content: "192.0.2.1",
    });
    const host = await call("installations", {
      accountId: ACCOUNT,
      workerName: "other",
      hostname: "app.example.com",
      handoffHash: HANDOFF_HASH,
    });
    expect(host.status).toBe(409);
    expect(host.body).toMatchObject({ error: { code: "hostname_taken" } });
    expect((await call("installations/find", { accountId: ACCOUNT })).body).toEqual({
      installations: [],
    });
  });

  it("refuses a second installation of the same name", async () => {
    await createInstallation(call);
    const again = await call("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: null,
      handoffHash: HANDOFF_HASH,
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: "name_taken" } });
  });

  it("needs a domain when the account has no workers.dev subdomain", async () => {
    world.subdomain = null;
    const answer = await call("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: null,
      handoffHash: HANDOFF_HASH,
    });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: { code: "no_workers_dev" } });
    const withDomain = await createInstallation(call, { hostname: "app.example.com" });
    expect(withDomain.address).toBe("https://app.example.com");
  });

  it("refuses a release older than the minimum version, in plain words", async () => {
    world = new FakeWorld(await buildRelease({ version: "0.3.1" }));
    call = installerApp(world);
    const answer = await call("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: null,
      handoffHash: HANDOFF_HASH,
    });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({
      error: {
        code: "release_too_old",
        message:
          "The newest Appflare release (0.3.1) cannot be installed from the browser; that needs Appflare 0.4.0 or newer. Try again after the next release, or install with create-appflare.",
      },
    });
  });

  it("refuses a release whose signature does not verify, or that a catalog key signed", async () => {
    const stranger = await signingKeyPair("appflare-test");
    const wrongKey = installerApp(world, { keys: [stranger.key] });
    const bad = await wrongKey("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: null,
      handoffHash: HANDOFF_HASH,
    });
    expect(bad.status).toBe(502);
    expect(bad.body).toMatchObject({ error: { code: "release_invalid" } });

    world = new FakeWorld(await buildRelease({ keyId: "catalog-test" }));
    const catalogSigned = await installerApp(world)("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: null,
      handoffHash: HANDOFF_HASH,
    });
    expect(catalogSigned.body).toMatchObject({ error: { code: "release_invalid" } });
  });

  it("says what is wrong with the release: none listed, an invalid manifest, a bad signature", async () => {
    const body = {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: null,
      handoffHash: HANDOFF_HASH,
    };
    world.latestTag = "create-appflare@0.3.0";
    expect((await call("installations", body)).body).toEqual({
      error: {
        code: "no_release",
        message:
          "GitHub does not list an Appflare release to install right now. Try again later, or install Appflare with create-appflare.",
      },
    });

    world = new FakeWorld(await buildRelease({ tweak: (m) => Object.assign(m, { app: "cut" }) }));
    const manifest = await installerApp(world)("installations", body);
    expect(manifest.body).toMatchObject({
      error: {
        code: "release_invalid",
        message: expect.stringMatching(/description of its files/),
      },
    });

    world = new FakeWorld(await buildRelease());
    world.release.signature = (await signingKeyPair("appflare-test")).key.publicKeyBase64;
    const signature = await installerApp(world)("installations", body);
    expect(signature.body).toMatchObject({
      error: {
        code: "release_invalid",
        message: expect.stringMatching(/valid Appflare signature/),
      },
    });
  });

  it("refuses a release that needs bindings this installer does not create", async () => {
    world = new FakeWorld(
      await buildRelease({
        tweak: (m) => {
          m.worker.bindings.push({ type: "r2_bucket", name: "FILES" });
        },
      }),
    );
    const answer = await installerApp(world)("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: null,
      handoffHash: HANDOFF_HASH,
    });
    expect(answer.body).toMatchObject({ error: { code: "release_unsupported" } });
  });
});

describe("development release", () => {
  it("installs a dev-signed release from the configured URL in development only", async () => {
    const dev = await signingKeyPair("dev-local");
    const release = await buildRelease({ version: "0.4.0-dev.1", keyId: "dev-local" });
    release.signature = await dev.sign(release.manifestBytes);
    world = new FakeWorld(release);
    const devCall = installerApp(world, {
      env: {
        DEV_RELEASE_URL,
        DEV_RELEASE_KEYS: JSON.stringify(dev.key),
        MIN_MANAGER_VERSION: "0.4.0-dev.0",
      },
      keys: [],
    });
    const answer = await devCall("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: null,
      handoffHash: HANDOFF_HASH,
    });
    expect(answer.status).toBe(200);
    expect(world.calls.some((c) => c.includes("github.com"))).toBe(false);
    const row = await recordRow((answer.body as { installationId: string }).installationId);
    expect(row?.release_zip_url).toBe(`${DEV_RELEASE_URL}/appflare-0.4.0-dev.1.zip`);
    expect(row?.release_key_id).toBe("dev-local");
  });

  it("never accepts a dev key for a GitHub release, nor a non-dev key id as a dev key", async () => {
    const dev = await signingKeyPair("dev-local");
    const release = await buildRelease({ keyId: "dev-local" });
    release.signature = await dev.sign(release.manifestBytes);
    world = new FakeWorld(release);
    // Without the override the dev-signed release comes from GitHub and fails.
    const viaGithub = await installerApp(world, { keys: [dev.key] })("installations", {
      accountId: ACCOUNT,
      workerName: "appflare-probe",
      hostname: null,
      handoffHash: HANDOFF_HASH,
    });
    expect(viaGithub.body).toMatchObject({ error: { code: "release_invalid" } });
    const badKey = await signingKeyPair("appflare-x");
    const misnamed = await installerApp(world, {
      env: { DEV_RELEASE_URL, DEV_RELEASE_KEYS: JSON.stringify(badKey.key) },
    })("accounts");
    expect(misnamed.status).toBe(503);
  });
});

describe("POST installations/find", () => {
  it("lists the account's unfinished installations without keys", async () => {
    const created = await createInstallation(call);
    const answer = await call("installations/find", { accountId: ACCOUNT });
    expect(answer.body).toEqual({
      installations: [
        {
          id: created.installationId,
          workerName: "appflare-probe",
          hostname: null,
          address: created.address,
          status: "running",
          step: { id: "release", label: "Check the Appflare release" },
          done: 0,
          total: 10,
          release: { version: "0.4.0" },
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ],
    });
    expect(answer.text).not.toContain(created.key);
  });

  it("refuses an account the token cannot reach", async () => {
    await createInstallation(call);
    world.accounts = [{ id: OTHER_ACCOUNT, name: "Other" }];
    const answer = await call("installations/find", { accountId: ACCOUNT });
    expect(answer.status).toBe(403);
    expect(answer.text).not.toContain("appflare-probe");
  });
});

describe("POST installations/<id>/complete", () => {
  it("needs no token, only the key, and deletes the record", async () => {
    const created = await createInstallation(call);
    const wrong = await call(
      `installations/${created.installationId}/complete`,
      { key: "B".repeat(43) },
      { token: null },
    );
    expect(wrong.status).toBe(403);
    const done = await call(
      `installations/${created.installationId}/complete`,
      { key: created.key },
      { token: null },
    );
    expect(done.body).toEqual({ ok: true });
    expect(done.subrequests).toBe(0);
    expect(await recordRow(created.installationId)).toBeNull();
    const again = await call(
      `installations/${created.installationId}/complete`,
      { key: created.key },
      { token: null },
    );
    expect(again.status).toBe(404);
  });
});
