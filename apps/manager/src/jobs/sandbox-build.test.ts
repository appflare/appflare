import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ArtifactManifest, BuildOutcome, CatalogManifest, IndexApp } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { CATALOG_INDEX_KEY } from "../catalog/index.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import type { StartInstallInput } from "../installs/install-input";
import { catalogOnlyManifest, startInstallCore } from "../installs/start-install.server";
import { startUpdateCore } from "../installs/versions.server";
import {
  type ArtifactFixture,
  type ArtifactFixtureOptions,
  baseCatalog,
  buildArtifactFixture,
} from "../test/artifact-fixture";
import { ACC, fakeAccount, SUBDOMAIN, TOKEN } from "../test/fake-account";
import { type EmailWorld, fakeEmailRouting, ZONE_ID } from "../test/fake-email-routing";
import {
  CATALOG_MANIFEST_URL,
  type FakeSandbox,
  type FakeSandboxOptions,
  fakeSandbox,
  publishedCatalog,
  SANDBOX_IMAGE,
  sandboxIndexApp,
} from "../test/fake-sandbox";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { INSTALL_ID, OLD_VERSION, seedInstall } from "../test/seed-install";
import { type InstallJobParams, runInstall } from "./install";
import { SANDBOX_BUILD_STEP } from "./install/artifact-source";
import type { JobEnv } from "./run-job";
import { runUninstall } from "./uninstall";
import { runUpdate, type UpdateJobParams } from "./update";

/**
 * Sandbox tier apps in the install, update and uninstall jobs, end to end:
 * the account is the stateful fake (fake-account.ts), the sandbox Worker is
 * a fake `SANDBOX` binding (RPC methods plus a Range-capable `fetch` over
 * its bucket), and the Workflow engine is `fakeStep`.
 */

const NOW = 1_790_000_000_000;
const PIN = baseCatalog().source.sha;

/** A sandbox build of Cut: unsigned, from the pin, carrying a sandbox tier catalog manifest. */
function sandboxApp(over: ArtifactFixtureOptions = {}): Promise<ArtifactFixture> {
  return buildArtifactFixture({
    keyId: "unsigned",
    ...over,
    catalog: {
      ...over.catalog,
      install: { ...baseCatalog().install, tier: "sandbox", ...over.catalog?.install },
    },
  });
}

interface World {
  fixture: ArtifactFixture;
  /** What the catalog publishes as the entry's manifest (defaults to the fixture's). */
  published: Uint8Array;
}

/** The account, the published catalog manifest, and the fixture's own files. */
function worldFetch(w: World, account: ReturnType<typeof fakeAccount>) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    if (input === CATALOG_MANIFEST_URL) return new Response(new Uint8Array(w.published));
    const path = new URL(input).pathname.replace(`/client/v4/accounts/${ACC}`, "");
    if (`${init?.method ?? "GET"} ${path}` === "GET /tokens/verify") {
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: { status: "active" },
      });
    }
    if (`${init?.method ?? "GET"} ${path}` === "POST /d1/database") {
      const { name } = (await new Request(input, init).json()) as { name: string };
      const db = { uuid: `d1-new-${account.state.d1.length + 1}`, name };
      account.state.d1.push(db);
      return Response.json({ success: true, errors: [], messages: [], result: db });
    }
    if (/^PUT \/workers\/scripts\/[^/]+\/secrets$/.test(`${init?.method ?? "GET"} ${path}`)) {
      return Response.json({ success: true, errors: [], messages: [], result: {} });
    }
    return account.fetch(input, init);
  };
}

async function install(opts: {
  fixture?: ArtifactFixture;
  sandbox?: FakeSandboxOptions | "none";
  input?: Partial<StartInstallInput>;
  params?: (p: InstallJobParams) => InstallJobParams;
  /** Bytes served at the catalog manifest URL, when not what the index describes. */
  published?: Uint8Array;
  /** The catalog manifest the catalog publishes and indexes, when not the fixture's. */
  catalog?: CatalogManifest;
  /** What the install start sees; defaults to whether the job gets a binding. */
  sandboxConnected?: boolean;
  /** One zone's Email Routing, answered in front of the account. */
  email?: Partial<EmailWorld>;
}) {
  const fixture = opts.fixture ?? (await sandboxApp());
  const catalog = opts.catalog ?? fixture.manifest.catalog;
  const app = await sandboxIndexApp(fixture, {
    manifestDigest: (await publishedCatalog(catalog)).digest,
  });
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.accountSubdomain]: SUBDOMAIN,
  });
  const account = fakeAccount(fixture);
  const w: World = {
    fixture,
    published: opts.published ?? (await publishedCatalog(catalog)).bytes,
  };
  const email = opts.email === undefined ? null : fakeEmailRouting(ACC, opts.email);
  const accountFetch = worldFetch(w, account);
  const fetch = async (input: string, init?: RequestInit): Promise<Response> =>
    (await email?.handle(new Request(input, init))) ?? accountFetch(input, init);
  const sandbox: FakeSandbox | undefined =
    opts.sandbox === "none" ? undefined : fakeSandbox(fixture, opts.sandbox ?? {});
  let params: InstallJobParams | null = null;
  let n = 0;
  const ids = await startInstallCore(
    {
      db: env.DB,
      loadApp: async () => ({ app, manifest: catalogOnlyManifest(catalog) }),
      sandboxConnected: opts.sandboxConnected ?? sandbox !== undefined,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => `id${++n}`,
    },
    {
      slug: "cut",
      workerName: "cut",
      secrets: { ADMIN_PASSWORD: "pw" },
      vars: {},
      paidConfirmed: false,
      requirementsConfirmed: false,
      buildConfirmed: true,
      ...opts.input,
    },
  );
  if (params === null) throw new Error("no Workflow params");
  const jobParams = opts.params?.(params) ?? params;
  const step = fakeStep();
  const baseEnv: JobEnv = {
    DB: env.DB,
    KV: env.KV,
    CF_API_TOKEN: TOKEN,
    ...(sandbox === undefined ? {} : { SANDBOX: sandbox }),
  };
  const self = fakeSelf(baseEnv, { fetch, now: () => NOW });
  let error: unknown = null;
  try {
    await runInstall({
      params: jobParams,
      step,
      env: { ...baseEnv, SELF: self },
      deps: { fetch, now: () => NOW },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT status, error, input_json FROM jobs WHERE id = ?1")
    .bind(ids.jobId)
    .first<{ status: string; error: string | null; input_json: string }>();
  const row = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
    .bind(ids.installId)
    .first<Record<string, unknown>>();
  const logs = (
    await env.DB.prepare("SELECT level, message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(ids.jobId)
      .all<{ level: string; message: string }>()
  ).results;
  return {
    ...ids,
    params: jobParams,
    fixture,
    account,
    sandbox,
    self,
    email,
    step,
    error,
    job,
    row,
    logs,
  };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("installing a sandbox tier app", () => {
  it("builds the pin in the sandbox Worker, reads the build through it, and records provenance", async () => {
    const r = await install({});
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.params.build).toMatchObject({ pin: PIN, costConfirmed: true });
    expect(r.params.artifacts).toBeUndefined();
    expect(JSON.parse(r.job?.input_json ?? "{}")).toMatchObject({ sandboxBuild: true });

    // The request carries the catalog manifest verbatim and matches it.
    expect(r.sandbox?.requests).toHaveLength(1);
    expect(r.sandbox?.requests[0]).toMatchObject({
      protocol: 1,
      installId: r.installId,
      version: "1.0.0",
      repo: "MendyLanda/cut",
      sha: PIN,
      wranglerConfigPath: "wrangler.jsonc",
      instanceType: "standard-1",
      catalogManifest: { slug: "cut", install: { tier: "sandbox" } },
    });

    const at = r.step.names.indexOf("build in sandbox");
    expect(r.step.names.slice(at - 3, at + 2)).toEqual([
      "check sandbox Worker",
      "load catalog manifest",
      "wait for the sandbox Worker to settle",
      "build in sandbox",
      "verify built manifest",
    ]);
    expect(r.step.configs[at]).toEqual(SANDBOX_BUILD_STEP);

    // The Worker module was read with a Range request through the binding.
    const zip = `https://sandbox/builds/${r.installId}/1.0.0/cut-1.0.0.zip`;
    expect(r.sandbox?.fetches.some((f) => f.startsWith(`GET ${zip} bytes=`))).toBe(true);
    expect(r.account.state.versions).toHaveLength(1);

    expect(r.row).toMatchObject({
      status: "installed",
      build_kind: "sandbox",
      sandbox_image: SANDBOX_IMAGE,
      built_at: NOW,
      artifact_url: zip,
      artifact_digest: r.fixture.digest,
      pin_sha: PIN,
    });
    expect(r.logs.some((l) => l.message.startsWith("Built cut 1.0.0 from"))).toBe(true);
    expect(r.logs.filter((l) => l.level === "debug").map((l) => l.message)).toEqual([
      "Cloning",
      "Installing",
      "Packing",
    ]);
  });

  it("sets up Email Routing from the catalog manifest the build carries", async () => {
    const catalog = { ...baseCatalog().install, tier: "sandbox" as const };
    const fixture = await sandboxApp({
      catalog: { install: { ...catalog, emailRouting: { rules: ["inbox"], catchAll: true } } },
      bindings: [{ type: "send_email", name: "EMAIL" }],
    });
    const r = await install({
      fixture,
      email: {},
      input: { emailRouting: { zoneId: ZONE_ID } },
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    // The zone is checked after the build is verified (its manifest carries
    // the entry's `install.emailRouting`) and before anything is created.
    const names = r.step.names;
    expect(names.indexOf("verify built manifest")).toBeLessThan(
      names.indexOf("check Email Routing"),
    );
    expect(names.indexOf("check Email Routing")).toBeLessThan(
      names.indexOf("upload Worker script"),
    );
    expect(r.self.calls.map((c) => c.unit)).toContain("inspectEmailRouting");
    const world = r.email?.world;
    expect(world?.routingEnabled).toBe(true);
    expect(world?.rules).toHaveLength(1);
    expect(world?.rules[0]).toMatchObject({
      matchers: [{ type: "literal", field: "to", value: "inbox@example.com" }],
      actions: [{ type: "worker", value: ["cut"] }],
    });
    expect(world?.catchAll).toMatchObject({
      enabled: true,
      actions: [{ type: "worker", value: ["cut"] }],
    });
    const routes = (
      await env.DB.prepare(
        "SELECT name FROM resources WHERE install_id = ?1 AND kind = 'email_route' ORDER BY rowid",
      )
        .bind(r.installId)
        .all<{ name: string }>()
    ).results.map((x) => x.name);
    expect(routes).toEqual(["example.com", "inbox@example.com", "*@example.com"]);
  });

  it("refuses to start an app that receives email without a zone", async () => {
    const fixture = await sandboxApp({
      catalog: {
        install: { ...baseCatalog().install, tier: "sandbox", emailRouting: { catchAll: true } },
      },
    });
    await expect(install({ fixture, email: {} })).rejects.toThrow(
      "Choose the zone whose email it should receive",
    );
  });

  it("refuses to start without the cost confirmation", async () => {
    await expect(install({ input: { buildConfirmed: false } })).rejects.toThrow(
      /Confirm the build's cost/,
    );
  });

  it("refuses to start when the manager has no SANDBOX binding", async () => {
    await expect(install({ sandbox: "none" })).rejects.toThrow(/not connected to one/);
  });

  it("fails before anything is created when the SANDBOX binding went away after the start", async () => {
    const r = await install({ sandbox: "none", sandboxConnected: true });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^check sandbox Worker: .*not connected/);
    expect(r.account.state.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  it("fails when the job payload lacks the cost confirmation", async () => {
    const r = await install({
      params: (p) => ({ ...p, build: p.build && { ...p.build, costConfirmed: false } }),
    });
    expect(r.job?.error).toMatch(/^check sandbox Worker: .*confirm the build's cost/);
    expect(r.sandbox?.requests).toEqual([]);
  });

  it("refuses a published catalog manifest that does not match the index digest", async () => {
    const other = await publishedCatalog(baseCatalog({ summary: "Something else" }));
    const r = await install({ published: other.bytes });
    expect(r.job?.error).toMatch(/^load catalog manifest: .*does not match the catalog index/);
    expect(r.sandbox?.requests).toEqual([]);
  });

  it("refuses an app that lists install directories on a sandbox Worker that predates them", async () => {
    const withDirs = (installDirs: CatalogManifest["install"]["installDirs"]) =>
      sandboxApp({
        catalog: { install: { ...baseCatalog().install, tier: "sandbox", installDirs } },
      });
    const r = await install({
      fixture: await withDirs([{ path: "templates/blog", lockfile: "none" }]),
      sandbox: {
        info: {
          protocol: 1,
          sandboxVersion: "0.1.4",
          image: "docker.io/mendylanda/appflare-sandbox:0.1.4",
          features: ["self-deploying", "repository-builds", "github-tokens"],
        },
      },
    });
    expect(r.job?.error).toContain(
      "the sandbox Worker 0.1.4 cannot install the directories this app lists (install.installDirs); to update it, choose Update sandbox in",
    );
    expect(r.sandbox?.requests).toEqual([]);
    expect(r.account.state.versions).toEqual([]);
  });

  it("builds an app that lists install directories on a sandbox Worker that installs them", async () => {
    const installDirs = [{ path: "." }];
    const r = await install({
      fixture: await sandboxApp({
        catalog: { install: { ...baseCatalog().install, tier: "sandbox", installDirs } },
      }),
    });
    expect(r.job?.error ?? null).toBeNull();
    expect(r.sandbox?.requests[0]).toMatchObject({ catalogManifest: { install: { installDirs } } });
  });

  it("reports a failed build with its step and exit code, without retrying it", async () => {
    const failed: BuildOutcome = {
      ok: false,
      protocol: 1,
      sandboxVersion: "0.4.0",
      minutes: 1,
      logKey: null,
      log: "ERR_PNPM_OUTDATED_LOCKFILE",
      stage: "install",
      message: "pnpm install exited with 1",
      retryable: false,
      exitCode: 1,
    };
    const r = await install({ sandbox: { outcome: () => failed } });
    expect(r.job?.error).toBe(
      "build in sandbox: the build failed in its install step (exit code 1): pnpm install exited with 1",
    );
    expect(r.sandbox?.requests).toHaveLength(1);
    expect(r.logs.some((l) => l.message === "ERR_PNPM_OUTDATED_LOCKFILE")).toBe(true);
    expect(r.account.state.versions).toEqual([]);
  });

  it("reads D1 migration files of the build through the sandbox Worker", async () => {
    const r = await install({
      fixture: await sandboxApp({
        bindings: [{ type: "d1", name: "DB" }],
        d1: {
          DB: [
            { name: "0001_init.sql", content: "CREATE TABLE links (id TEXT);" },
            { name: "0002_hits.sql", content: "ALTER TABLE links ADD COLUMN hits INTEGER;" },
          ],
        },
      }),
    });
    expect(r.error).toBeNull();
    const zip = `https://sandbox/builds/${r.installId}/1.0.0/cut-1.0.0.zip`;
    const d1Step = r.step.names.find((n) => n.startsWith("D1 DB: apply migrations"));
    expect(d1Step).toBeDefined();
    expect(Object.values(r.account.state.applied).flat()).toEqual([
      "0001_init.sql",
      "0002_hits.sql",
    ]);
    // Every read of the zip went through the binding (worker module and SQL files).
    expect(
      r.sandbox?.fetches.filter((f) => f.startsWith(`GET ${zip} bytes=`)).length,
    ).toBeGreaterThan(1);
  });

  it("runs a build at most twice", async () => {
    const r = await install({ sandbox: { retryableFailures: 2 } });
    expect(r.job?.status).toBe("failed");
    expect(r.sandbox?.requests).toHaveLength(2);
    expect(r.job?.error).toMatch(/^build in sandbox: the build failed in its checkout step/);
  });

  it("deletes the builds of a failed install when it is uninstalled", async () => {
    const failedBuild: BuildOutcome = {
      ok: false,
      protocol: 1,
      sandboxVersion: "0.4.0",
      minutes: 1,
      logKey: null,
      log: "",
      stage: "pack",
      message: "the pack failed",
      retryable: false,
      exitCode: 1,
    };
    const r = await install({ sandbox: { outcome: () => failedBuild } });
    expect(r.row?.build_kind).toBe("artifact");
    const sandbox = r.sandbox;
    if (sandbox === undefined) throw new Error("no sandbox");
    await runUninstall({
      params: { kind: "uninstall", jobId: "job-u", installId: r.installId, deleteResources: [] },
      step: fakeStep(),
      env: { DB: env.DB, CF_API_TOKEN: TOKEN, SANDBOX: sandbox },
      deps: { fetch: r.account.fetch, now: () => NOW },
    });
    expect(sandbox.cleanups).toEqual([{ installId: r.installId, keepVersions: [] }]);
  });

  it("retries a build whose container went away", async () => {
    const r = await install({ sandbox: { retryableFailures: 1 } });
    expect(r.job?.status).toBe("succeeded");
    expect(r.sandbox?.requests).toHaveLength(2);
    expect(r.step.retried["build in sandbox"]).toBe(2);
  });

  it("refuses a manifest.json whose digest is not the one the build reported", async () => {
    const r = await install({ sandbox: { manifestBytes: new TextEncoder().encode("{}") } });
    expect(r.job?.error).toMatch(
      /^verify built manifest: .*does not match the one the build reported/,
    );
    expect(r.account.state.versions).toEqual([]);
  });

  async function refused(tweak: (m: ArtifactManifest) => void): Promise<string | null> {
    const fixture = await sandboxApp({ tweak });
    const r = await install({ fixture, catalog: sandboxCatalog() });
    expect(r.account.state.versions).toEqual([]);
    return r.job?.error ?? null;
  }
  const sandboxCatalog = () =>
    baseCatalog({ install: { ...baseCatalog().install, tier: "sandbox" } });

  it("refuses a build that is signed, from another commit, or carries another catalog manifest", async () => {
    expect(
      await refused((m) => {
        m.keyId = "catalog-2026-09";
      }),
    ).toMatch(/verify built manifest: .*a sandbox build is always unsigned/);
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    expect(
      await refused((m) => {
        m.source.sha = "f".repeat(40);
      }),
    ).toMatch(/verify built manifest: .*not the pinned/);
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    expect(
      await refused((m) => {
        m.catalog.postInstall = [{ type: "markdown", content: "Visit elsewhere." }];
      }),
    ).toMatch(/verify built manifest: .*does not carry the catalog manifest it was built from/);
  });
});

describe("updating and uninstalling a sandbox tier app", () => {
  async function seedSandboxInstall(): Promise<void> {
    await seedInstall({
      version: "0.9.0",
      resources: [
        { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
        { kind: "worker", name: "cut", cfId: "cut" },
        { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" },
      ],
    });
    await env.DB.prepare(
      "UPDATE installs SET build_kind = 'sandbox', sandbox_image = 'docker.io/mendylanda/appflare-sandbox:0.3.0', built_at = 5 WHERE id = ?1",
    )
      .bind(INSTALL_ID)
      .run();
  }

  async function update(
    sandboxOver: FakeSandboxOptions | "none" = {},
    opts: { app?: ArtifactFixtureOptions; confirmNoPreview?: boolean } = {},
  ) {
    const fixture = await sandboxApp(opts.app);
    const app: IndexApp = await sandboxIndexApp(fixture);
    const account = fakeAccount(fixture, {
      deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
      previews: [{ status: 200, body: "ok" }],
    });
    const w: World = {
      fixture,
      published: (await publishedCatalog(fixture.manifest.catalog)).bytes,
    };
    const fetch = worldFetch(w, account);
    const sandbox = sandboxOver === "none" ? undefined : fakeSandbox(fixture, sandboxOver);
    await seedSandboxInstall();
    await env.KV.put(
      CATALOG_INDEX_KEY,
      JSON.stringify({ generatedAt: "2026-09-23T00:00:00.000Z", apps: [app] }),
    );
    let params: UpdateJobParams | null = null;
    const deps = {
      db: env.DB,
      loadApp: async () => app,
      loadManifest: async (): Promise<ArtifactManifest> => {
        throw new Error("a sandbox tier app has no artifact manifest to load");
      },
      loadCatalog: async () => fixture.manifest.catalog,
      sandboxConnected: sandbox !== undefined,
      createJob: async (id: string, p: UpdateJobParams) => {
        params = p;
        return { id };
      },
      newId: () => "job1",
    };
    const first = await startUpdateCore(deps, { installId: INSTALL_ID });
    if ("jobId" in first) throw new Error("expected a cost confirmation first");
    expect(first.build).toMatchObject({ pin: PIN, expectedMinutes: 5 });
    const started = await startUpdateCore(deps, {
      installId: INSTALL_ID,
      buildConfirmed: true,
      ...(opts.confirmNoPreview === undefined ? {} : { confirmNoPreview: opts.confirmNoPreview }),
    });
    if (!("jobId" in started) || params === null) throw new Error("no Workflow params");
    const step = fakeStep();
    const baseEnv: JobEnv = {
      DB: env.DB,
      KV: env.KV,
      CF_API_TOKEN: TOKEN,
      ...(sandbox === undefined ? {} : { SANDBOX: sandbox }),
    };
    let error: unknown = null;
    try {
      await runUpdate({
        params,
        step,
        env: { ...baseEnv, SELF: fakeSelf(baseEnv, { fetch }) },
        deps: { fetch, now: () => NOW },
      });
    } catch (e) {
      error = e;
    }
    const install = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
      .bind(INSTALL_ID)
      .first<Record<string, unknown>>();
    const snapshot = await env.DB.prepare("SELECT * FROM snapshots WHERE job_id = 'job1'").first<
      Record<string, unknown>
    >();
    const job = await env.DB.prepare("SELECT status, error FROM jobs WHERE id = 'job1'").first<{
      status: string;
      error: string | null;
    }>();
    return { error, install, snapshot, sandbox, step, job };
  }

  it("builds the new version, keeps the old provenance in the snapshot, and trims old builds", async () => {
    const r = await update();
    expect(r.error).toBeNull();
    expect(r.sandbox?.requests[0]).toMatchObject({ installId: INSTALL_ID, version: "1.0.0" });
    expect(r.install).toMatchObject({
      catalog_version: "1.0.0",
      build_kind: "sandbox",
      sandbox_image: SANDBOX_IMAGE,
      built_at: NOW,
      artifact_url: `https://sandbox/builds/${INSTALL_ID}/1.0.0/cut-1.0.0.zip`,
    });
    expect(r.snapshot).toMatchObject({
      build_kind: "sandbox",
      sandbox_image: "docker.io/mendylanda/appflare-sandbox:0.3.0",
      built_at: 5,
    });
    expect(r.sandbox?.cleanups).toEqual([
      { installId: INSTALL_ID, keepVersions: ["1.0.0", "0.9.0"] },
    ]);
  });

  it("refuses a build that cannot be checked on a preview unless the admin confirmed it", async () => {
    const withObject: ArtifactFixtureOptions = {
      bindings: [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
      ],
    };
    const refused = await update({}, { app: withObject });
    expect(refused.job?.error).toMatch(
      /^plan update: .*known only once the version was built; start the update again and confirm/,
    );
    expect(refused.install?.catalog_version).toBe("0.9.0");

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    const confirmed = await update({}, { app: withObject, confirmNoPreview: true });
    expect(confirmed.job?.status).toBe("succeeded");
    expect(confirmed.step.names).toContain("skip canary");
  });

  it("refuses to start an update without the SANDBOX binding", async () => {
    await expect(update("none")).rejects.toThrow(/not connected to one/);
  });

  it("deletes every build of the install when it is uninstalled", async () => {
    await seedSandboxInstall();
    const sandbox = fakeSandbox(await sandboxApp());
    const account = fakeAccount(null);
    await runUninstall({
      params: { kind: "uninstall", jobId: "job2", installId: INSTALL_ID, deleteResources: [] },
      step: fakeStep(),
      env: { DB: env.DB, CF_API_TOKEN: TOKEN, SANDBOX: sandbox },
      deps: { fetch: account.fetch, now: () => NOW },
    });
    expect(sandbox.cleanups).toEqual([{ installId: INSTALL_ID, keepVersions: [] }]);
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = ?1")
      .bind(INSTALL_ID)
      .first<{ status: string }>();
    expect(install?.status).toBe("uninstalled");
  });

  it("uninstalls without the SANDBOX binding and says the builds stay", async () => {
    await seedSandboxInstall();
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('job2', ?1, 'uninstall', 'queued')",
    )
      .bind(INSTALL_ID)
      .run();
    const account = fakeAccount(null);
    await runUninstall({
      params: { kind: "uninstall", jobId: "job2", installId: INSTALL_ID, deleteResources: [] },
      step: fakeStep(),
      env: { DB: env.DB, CF_API_TOKEN: TOKEN },
      deps: { fetch: account.fetch, now: () => NOW },
    });
    const logs = (
      await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = 'job2'").all<{
        message: string;
      }>()
    ).results.map((l) => l.message);
    expect(logs).toContain(
      "Appflare is not connected to the sandbox Worker, so this install's builds stay in its bucket (appflare-builds).",
    );
  });
});
