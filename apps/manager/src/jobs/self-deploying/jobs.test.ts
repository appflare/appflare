import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type CatalogManifest,
  catalogManifestSchema,
  type IndexApp,
  SANDBOX_PROTOCOL_VERSION,
} from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { CATALOG_INDEX_KEY } from "../../catalog/index.server";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { SETTING, writeSettings } from "../../db/settings";
import { replaceAppCredentialsCore } from "../../installs/app-credentials.server";
import type { StartInstallInput } from "../../installs/install-input";
import { startReconfigureCore } from "../../installs/reconfigure.server";
import type { StartReconfigureInput } from "../../installs/reconfigure-input";
import { catalogOnlyManifest, startInstallCore } from "../../installs/start-install.server";
import { startUninstallCore } from "../../installs/start-uninstall.server";
import { startRollbackCore, startUpdateCore } from "../../installs/versions.server";
import { baseCatalog } from "../../test/artifact-fixture";
import {
  ACC,
  fakeAccount,
  SANDBOX_DEPLOYED_VERSION,
  SUBDOMAIN,
  TOKEN,
} from "../../test/fake-account";
import {
  type FakeSandbox,
  type FakeSandboxOptions,
  fakeSandbox,
  publishedCatalog,
} from "../../test/fake-sandbox";
import { type FakeStep, fakeStep } from "../../test/fake-step";
import { type InstallJobParams, runInstall } from "../install";
import { type ReconfigureJobParams, runReconfigure } from "../reconfigure";
import type { JobEnv } from "../run-job";
import { runUninstall, type UninstallJobParams } from "../uninstall";
import { runUpdate, type UpdateJobParams } from "../update";
import { INSTALLER_RUN_STEP } from "./phases";

/**
 * Self-deploying apps end to end: the install start, then the install,
 * update and uninstall jobs, against the stateful fake account, a fake
 * `SANDBOX` binding that plays the sandbox Worker's installer runs, and the
 * fake Workflow engine. The container cannot run here.
 */

const NOW = 1_790_000_000_000;
const PIN = "84e4705503ceaef54d1b284c167de9942563cdae";
const NEW_PIN = "1111111111111111111111111111111111111111";
const APP_TOKEN = "app-own-token-value-DO-NOT-LEAK";
const SECRET = "admin-password-DO-NOT-LEAK";
const MANIFEST_URL = "https://appflare.github.io/catalog/apps/cut/appflare.json";
const STAGE = "appflare-id1";
const MAIN = `cut-${STAGE}`;
const JOBS = `cut-${STAGE}-jobs`;

function selfDeployingCatalog(over: { pin?: string; secrets?: CatalogManifest["secrets"] } = {}) {
  const base = baseCatalog();
  return catalogManifestSchema.parse({
    ...base,
    source: { ref: "v1.0.0", sha: over.pin ?? PIN },
    install: {
      tier: "self-deploying",
      packageManager: "pnpm",
      wranglerConfig: "wrangler.jsonc",
      workerName: "cut",
      buildCommand: "pnpm build",
      selfDeploying: {
        tool: "alchemy",
        deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
        destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
        workerNames: ["cut-{{stage}}", "cut-{{stage}}-jobs"],
      },
    },
    plan: "paid",
    requires: ["containers"],
    secrets: over.secrets ?? base.secrets,
    tokenPermissions: [
      { group: "Workers Scripts", scope: "account", access: "edit", reason: "Deploys the app." },
    ],
  });
}

async function indexApp(catalog: CatalogManifest, version = "1.0.0"): Promise<IndexApp> {
  return {
    slug: "cut",
    name: "Cut",
    summary: catalog.summary,
    tagline: catalog.tagline,
    addedAt: "2026-09-01T00:00:00Z",
    version,
    revision: catalog.revision,
    tier: "self-deploying",
    plan: "paid",
    requires: ["containers"],
    services: ["containers"],
    categories: catalog.categories,
    license: catalog.license,
    authors: [{ name: "MendyLanda", github: "MendyLanda" }],
    lastVerified: null,
    maintainers: ["MendyLanda"],
    build: {
      pin: catalog.source.sha,
      manifest: MANIFEST_URL,
      manifestDigest: (await publishedCatalog(catalog)).digest,
      expectedMinutes: 12,
    },
  };
}

/** The fake account, the published catalog manifest, and the sandbox Worker's secrets API. */
function world(opts: { catalog: () => CatalogManifest; held: Set<string> }) {
  const account = fakeAccount(null, { worker: MAIN });
  const secretCalls: string[] = [];
  const probes: string[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input === MANIFEST_URL) {
      return new Response(new Uint8Array((await publishedCatalog(opts.catalog())).bytes));
    }
    const url = new URL(input);
    if (url.host.endsWith(".acme.workers.dev")) {
      probes.push(input);
      // Behind Cloudflare Access: every request is sent to the login page.
      return new Response(null, {
        status: 302,
        headers: { location: "https://acme.cloudflareaccess.com" },
      });
    }
    const path = url.pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const method = init?.method ?? "GET";
    if (path.startsWith("/workers/scripts/appflare-sandbox/secrets")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      if (method === "PUT") {
        const body = (await new Request(input, init).json()) as { name: string; text: string };
        secretCalls.push(`PUT ${body.name}`);
        opts.held.add(body.name);
      } else {
        const name = decodeURIComponent(path.split("/").at(-1) ?? "");
        secretCalls.push(`DELETE ${name}`);
        opts.held.delete(name);
      }
      return Response.json({ success: true, errors: [], messages: [], result: {} });
    }
    return account.fetch(input, init);
  };
  return { account, fetch, secretCalls, probes };
}

/**
 * The fake Workflow engine, except that each step whose name starts with
 * `prefix` runs a second time after it finished, as Workflows can do.
 */
function replayingStep(prefix: string): FakeStep {
  const step = fakeStep();
  const run = step.do.bind(step) as (name: string, ...rest: unknown[]) => Promise<unknown>;
  const again = async (name: string, ...rest: unknown[]) => {
    const result = await run(name, ...rest);
    return name.startsWith(prefix) ? run(name, ...rest) : result;
  };
  return Object.assign(step, { do: again as FakeStep["do"] });
}

async function logsOf(jobId: string) {
  return (
    await env.DB.prepare("SELECT level, message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<{ level: string; message: string }>()
  ).results;
}

async function jobRow(jobId: string) {
  return env.DB.prepare("SELECT status, error, input_json FROM jobs WHERE id = ?1")
    .bind(jobId)
    .first<{ status: string; error: string | null; input_json: string }>();
}

async function installRow(installId: string) {
  return env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
    .bind(installId)
    .first<Record<string, unknown>>();
}

interface Setup {
  held: Set<string>;
  sandbox: FakeSandbox;
  w: ReturnType<typeof world>;
  catalog: CatalogManifest;
  jobEnv: JobEnv;
}

function setup(
  opts: {
    sandbox?: FakeSandboxOptions["selfManaged"];
    versionIds?: FakeSandboxOptions["versionIds"];
  } = {},
): Setup {
  const held = new Set<string>();
  const state: { catalog: CatalogManifest } = { catalog: selfDeployingCatalog() };
  const sandbox = fakeSandbox(null, {
    selfManaged: { held, ...opts.sandbox },
    versionIds: opts.versionIds,
  });
  const w = world({ catalog: () => state.catalog, held });
  return {
    held,
    sandbox,
    w,
    get catalog() {
      return state.catalog;
    },
    set catalog(c: CatalogManifest) {
      state.catalog = c;
    },
    jobEnv: { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN, SANDBOX: sandbox },
  };
}

async function startInstall(s: Setup, input: Partial<StartInstallInput> = {}) {
  let params: InstallJobParams | null = null;
  let n = 0;
  const app = await indexApp(s.catalog);
  const ids = await startInstallCore(
    {
      db: env.DB,
      loadApp: async () => ({ app, manifest: catalogOnlyManifest(s.catalog) }),
      sandboxConnected: true,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      listAccountWorkers: async () => ["someone-else"],
      newId: () => `id${++n}`,
    },
    {
      slug: "cut",
      workerName: "cut",
      secrets: { ADMIN_PASSWORD: SECRET },
      vars: {},
      paidConfirmed: true,
      requirementsConfirmed: true,
      buildConfirmed: true,
      appToken: APP_TOKEN,
      ...input,
    },
  );
  if (params === null) throw new Error("no Workflow params");
  return { ...ids, params: params as InstallJobParams };
}

async function install(s: Setup) {
  const started = await startInstall(s);
  const step = fakeStep();
  let error: unknown = null;
  try {
    await runInstall({
      params: started.params,
      step,
      env: s.jobEnv,
      deps: { fetch: s.w.fetch, now: () => NOW, sleep: async () => {} },
    });
  } catch (e) {
    error = e;
  }
  return { ...started, step, error };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.accountSubdomain]: SUBDOMAIN,
  });
});

describe("starting a self-deploying install", () => {
  it("refuses Cloudflare Access protection, before anything is recorded", async () => {
    const s = setup();
    await expect(startInstall(s, { access: true })).rejects.toThrow(
      /cannot protect it with Cloudflare Access yet/,
    );
    expect((await env.DB.prepare("SELECT id FROM installs").all()).results).toEqual([]);
  });

  it("claims the installer's main Worker and keeps the app token out of D1", async () => {
    const s = setup();
    const r = await startInstall(s);
    expect(r.installId).toBe("id1");
    expect(r.params.workerName).toBe(MAIN);
    expect(r.params.selfDeploying).toMatchObject({
      pin: PIN,
      costConfirmed: true,
      appToken: APP_TOKEN,
    });
    expect(r.params.artifacts).toBeUndefined();
    const job = await jobRow(r.jobId);
    expect(job?.input_json).not.toContain(APP_TOKEN);
    expect(JSON.parse(job?.input_json ?? "{}")).toMatchObject({
      selfDeploying: true,
      sandboxRun: "deploy-1.0.0",
      workerName: MAIN,
    });
    const row = await installRow(r.installId);
    expect(row).toMatchObject({
      worker_name: MAIN,
      instance_name: "Cut",
      display_name: "Cut",
      build_kind: "self-deploying",
      artifact_url: MANIFEST_URL,
    });
  });

  it("refuses without the app token, the cost confirmation, or the sandbox Worker", async () => {
    const s = setup();
    await expect(startInstall(s, { appToken: "  " })).rejects.toThrow(/own Cloudflare API token/);
    await expect(startInstall(s, { buildConfirmed: false })).rejects.toThrow(/Confirm its cost/);
    const app = await indexApp(s.catalog);
    await expect(
      startInstallCore(
        {
          db: env.DB,
          loadApp: async () => ({ app, manifest: catalogOnlyManifest(s.catalog) }),
          sandboxConnected: false,
          createJob: async (id) => ({ id }),
        },
        {
          slug: "cut",
          workerName: "cut",
          secrets: { ADMIN_PASSWORD: SECRET },
          vars: {},
          paidConfirmed: true,
          requirementsConfirmed: true,
          buildConfirmed: true,
          appToken: APP_TOKEN,
        },
      ),
    ).rejects.toThrow(/not connected/);
  });

  it("refuses when one of the installer's Workers already exists", async () => {
    const s = setup();
    const app = await indexApp(s.catalog);
    await expect(
      startInstallCore(
        {
          db: env.DB,
          loadApp: async () => ({ app, manifest: catalogOnlyManifest(s.catalog) }),
          sandboxConnected: true,
          createJob: async (id) => ({ id }),
          listAccountWorkers: async () => [JOBS],
          newId: (() => {
            let n = 0;
            return () => `id${++n}`;
          })(),
        },
        {
          slug: "cut",
          workerName: "cut",
          secrets: { ADMIN_PASSWORD: SECRET },
          vars: {},
          paidConfirmed: true,
          requirementsConfirmed: true,
          buildConfirmed: true,
          appToken: APP_TOKEN,
        },
      ),
    ).rejects.toThrow(`A Worker named "${JOBS}" already exists`);
  });
});

describe("installing a self-deploying app", () => {
  it("stores the token on the sandbox Worker, deploys through it, and records what the installer made", async () => {
    const s = setup();
    const r = await install(s);
    expect(r.error).toBeNull();
    expect((await jobRow(r.jobId))?.status).toBe("succeeded");

    // Custody: the token and the secret go to the sandbox Worker as secrets,
    // with the manager's token, and never over the binding.
    expect(s.w.secretCalls).toEqual(["PUT APP_TOKEN_id1", "PUT APP_SECRET_id1_ADMIN_PASSWORD"]);
    expect(JSON.stringify(s.sandbox.runs)).not.toContain(APP_TOKEN);
    expect(JSON.stringify(s.sandbox.runs)).not.toContain(SECRET);

    expect(s.sandbox.runs).toHaveLength(1);
    expect(s.sandbox.runs[0]).toMatchObject({
      protocol: SANDBOX_PROTOCOL_VERSION,
      installId: "id1",
      runId: "deploy-1.0.0",
      accountId: ACC,
      tool: "alchemy",
      repo: "MendyLanda/cut",
      sha: PIN,
      ref: "v1.0.0",
      buildCommand: ["pnpm", "build"],
      command: ["pnpm", "alchemy", "deploy", "--yes"],
      stage: STAGE,
      stageArg: "--stage",
      tokenEnv: ["CLOUDFLARE_API_TOKEN"],
      accountIdEnv: ["CLOUDFLARE_ACCOUNT_ID"],
      secretNames: ["ADMIN_PASSWORD"],
      expectedWorkers: [MAIN, JOBS],
    });
    expect(r.step.configs[r.step.names.indexOf("deploy in sandbox")]).toEqual(INSTALLER_RUN_STEP);

    const rows = (
      await env.DB.prepare(
        "SELECT kind, name, managed_by FROM resources WHERE install_id = 'id1' ORDER BY rowid",
      ).all<{ kind: string; name: string; managed_by: string }>()
    ).results;
    expect(rows.map((x) => `${x.kind} ${x.name} ${x.managed_by}`)).toEqual([
      "secret ADMIN_PASSWORD app",
      `worker ${MAIN} app`,
      `worker ${JOBS} app`,
      `d1 db-${STAGE} app`,
    ]);

    // Health through Access: the Worker's own redirect counts (any-response).
    expect(s.w.probes).toEqual([`https://${MAIN}.acme.workers.dev/`]);
    const row = await installRow(r.installId);
    expect(row).toMatchObject({
      status: "installed",
      build_kind: "self-deploying",
      pin_sha: PIN,
      sandbox_image: "docker.io/mendylanda/appflare-sandbox:0.4.0",
      health_status: "verified",
      artifact_digest: (await publishedCatalog(s.catalog)).digest,
    });
    expect(JSON.parse(String(row?.manifest_json)).install.tier).toBe("self-deploying");

    const logs = await logsOf(r.jobId);
    expect(JSON.stringify(logs)).not.toContain(APP_TOKEN);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(logs.some((l) => l.message.includes("APP_TOKEN_id1"))).toBe(true);
  });

  it("logs each stored secret once and waits for the sandbox Worker to settle before the run", async () => {
    // The version from before the secret writes answers first (the sandbox
    // Worker check asks too, before them).
    const s = setup({ versionIds: ["old-version", "old-version", SANDBOX_DEPLOYED_VERSION] });
    const r = await install(s);
    expect(r.error).toBeNull();
    const at = (name: string) => r.step.names.indexOf(name);
    expect(at("store app secret ADMIN_PASSWORD on the sandbox Worker")).toBeLessThan(
      at("wait for the sandbox Worker to settle"),
    );
    expect(at("wait for the sandbox Worker to settle")).toBeLessThan(
      at("check app token on the sandbox Worker"),
    );
    expect(at("check app token on the sandbox Worker")).toBeLessThan(at("deploy in sandbox"));
    // The check, then the old version once, then the new one three times in a row.
    expect(s.sandbox.infoCalls).toBe(1 + 1 + 3);

    const messages = (await logsOf(r.jobId)).map((l) => l.message);
    expect(messages).toContain(
      "The sandbox Worker is settled: Appflare waited for its deployed version 5a5d0000, and version 5a5d0000 answered (4 answer(s)).",
    );
    const stored = messages.filter((m) => m.startsWith("Stored ADMIN_PASSWORD"));
    expect(stored).toHaveLength(1);
  });

  it("stores and logs each secret once when its step runs again after it finished", async () => {
    const s = setup();
    const started = await startInstall(s);
    await runInstall({
      params: started.params,
      step: replayingStep("store app "),
      env: s.jobEnv,
      deps: { fetch: s.w.fetch, now: () => NOW },
    });
    expect((await jobRow(started.jobId))?.status).toBe("succeeded");
    // Each write deploys a new version of the sandbox Worker: none is repeated.
    expect(s.w.secretCalls).toEqual(["PUT APP_TOKEN_id1", "PUT APP_SECRET_id1_ADMIN_PASSWORD"]);
    const messages = (await logsOf(started.jobId)).map((l) => l.message);
    expect(messages.filter((m) => m.startsWith("Stored ADMIN_PASSWORD"))).toHaveLength(1);
    expect(messages.filter((m) => m.startsWith("Stored the app's token"))).toHaveLength(1);
  });

  it("fails on a failing installer and keeps what it needs to destroy later", async () => {
    const s = setup({
      sandbox: {
        deploy: (request) => ({
          ok: false,
          action: "deploy",
          protocol: 1,
          sandboxVersion: "0.4.0",
          minutes: 2,
          logKey: `builds/${request.installId}/${request.runId}/log.txt`,
          log: "Error: permission denied\n",
          step: "deploy",
          message: "the installer's deploy command failed (exit code 1)",
          retryable: false,
          exitCode: 1,
        }),
      },
    });
    const r = await install(s);
    expect(r.error).not.toBeNull();
    const job = await jobRow(r.jobId);
    expect(job?.error).toMatch(
      /^deploy in sandbox: the installer's deploy failed in its deploy step/,
    );
    const row = await installRow(r.installId);
    expect(row?.status).toBe("failed");
    // Recorded before the run, so the uninstall can run the destroy command.
    expect(JSON.parse(String(row?.manifest_json)).slug).toBe("cut");
    expect(row?.pin_sha).toBe(PIN);
  });

  it("retries a run whose container went away, once", async () => {
    const s = setup({ sandbox: { retryableFailures: 1 } });
    const r = await install(s);
    expect(r.error).toBeNull();
    expect(s.sandbox.runs).toHaveLength(2);
    expect(r.step.retried["deploy in sandbox"]).toBe(2);
    // The retry runs in a container of its own, not the one that went away.
    expect(s.sandbox.runs.map((run) => run.attempt)).toEqual([1, 2]);
  });

  it("does not touch the sandbox Worker's secrets while another job runs in it", async () => {
    const s = setup();
    // Another app's sandbox build, still running: a secret change would restart
    // the sandbox Worker and kill it.
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('busy1', NULL, 'install', 'running', ?1)",
    )
      .bind(JSON.stringify({ sandboxBuild: true, version: "2.0.0" }))
      .run();
    const r = await install(s);
    expect(r.error).not.toBeNull();
    expect((await jobRow(r.jobId))?.error).toMatch(
      /^store app token on the sandbox Worker: the sandbox Worker is busy with the install job busy1/,
    );
    expect(s.w.secretCalls).toEqual([]);
    expect(s.sandbox.runs).toEqual([]);

    await expect(
      replaceAppCredentialsCore(
        {
          db: env.DB,
          async putSandboxSecret() {
            throw new Error("must not be called");
          },
        },
        { installId: r.installId, appToken: "new-token" },
      ),
    ).rejects.toThrow(/^The sandbox Worker is busy with the install job busy1/);
  });

  it("refuses a sandbox Worker that cannot run installers", async () => {
    const s = setup();
    const started = await startInstall(s);
    const old = fakeSandbox(null, {
      info: {
        protocol: 1,
        sandboxVersion: "0.3.0",
        image: "docker.io/mendylanda/appflare-sandbox:0.3.0",
      },
    });
    await expect(
      runInstall({
        params: started.params,
        step: fakeStep(),
        env: { ...s.jobEnv, SANDBOX: old },
        deps: { fetch: s.w.fetch, now: () => NOW },
      }),
    ).rejects.toThrow(/cannot run app installers/);
    expect(s.w.secretCalls).toEqual([]);
  });
});

describe("updating a self-deploying app", () => {
  async function startUpdate(s: Setup, extra: { appToken?: string } = {}) {
    const next = selfDeployingCatalog({ pin: NEW_PIN });
    s.catalog = next;
    const app = await indexApp(next, "1.1.0");
    await env.KV.put(
      CATALOG_INDEX_KEY,
      JSON.stringify({ generatedAt: "2026-09-24T00:00:00.000Z", apps: [app] }),
    );
    let params: UpdateJobParams | null = null;
    const deps = {
      db: env.DB,
      loadApp: async () => app,
      loadManifest: async () => {
        throw new Error("a self-deploying app has no artifact manifest");
      },
      loadCatalog: async () => next,
      sandboxConnected: true,
      createJob: async (id: string, p: UpdateJobParams) => {
        params = p;
        return { id };
      },
      newId: () => "u1",
    };
    const first = await startUpdateCore(deps, { installId: "id1" });
    if ("jobId" in first) throw new Error("expected a cost confirmation first");
    expect(first).toMatchObject({
      selfDeploying: true,
      skipsPreview: null,
      build: { pin: NEW_PIN },
    });
    await startUpdateCore(deps, { installId: "id1", buildConfirmed: true, ...extra });
    if (params === null) throw new Error("no Workflow params");
    return params as UpdateJobParams;
  }

  it("runs the installer again at the new pin, without a snapshot", async () => {
    const s = setup();
    await install(s);
    const params = await startUpdate(s, { appToken: "rotated-token-value" });
    expect(params).toMatchObject({ selfDeploying: true, appToken: "rotated-token-value" });
    expect((await jobRow("u1"))?.input_json).not.toContain("rotated-token-value");
    await runUpdate({
      params,
      step: fakeStep(),
      env: s.jobEnv,
      deps: { fetch: s.w.fetch, now: () => NOW },
    });
    expect((await jobRow("u1"))?.status).toBe("succeeded");
    expect(s.sandbox.runs.at(-1)).toMatchObject({
      runId: "deploy-1.1.0",
      sha: NEW_PIN,
      stage: STAGE,
      command: ["pnpm", "alchemy", "deploy", "--yes"],
    });
    expect(s.w.secretCalls.at(-1)).toBe("PUT APP_TOKEN_id1");
    const row = await installRow("id1");
    expect(row).toMatchObject({ status: "installed", catalog_version: "1.1.0", pin_sha: NEW_PIN });
    const snapshots = await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots").first<{
      n: number;
    }>();
    expect(snapshots?.n).toBe(0);
    // Only this run's log is kept in the sandbox Worker's bucket.
    expect(s.sandbox.cleanups.at(-1)).toEqual({ installId: "id1", keepVersions: ["deploy-1.1.0"] });
  });

  it("stops before the installer when the sandbox Worker lost the token", async () => {
    const s = setup();
    await install(s);
    s.held.clear();
    const params = await startUpdate(s);
    await expect(
      runUpdate({
        params,
        step: fakeStep(),
        env: s.jobEnv,
        deps: { fetch: s.w.fetch, now: () => NOW },
      }),
    ).rejects.toThrow(
      /enter it again under \[Secrets in the app's settings\]\(\/apps\/id1#secrets\)/,
    );
    expect(s.sandbox.runs).toHaveLength(1);
    expect((await installRow("id1"))?.status).toBe("installed");
  });

  it("offers no rollback", async () => {
    const s = setup();
    await install(s);
    await expect(
      startRollbackCore(
        { db: env.DB, createJob: async (id) => ({ id }) },
        { installId: "id1", snapshotId: "none" },
      ),
    ).rejects.toThrow(/cannot roll it back/);
  });
});

describe("uninstalling a self-deploying app", () => {
  async function uninstall(s: Setup, step: FakeStep = fakeStep()) {
    let params: UninstallJobParams | null = null;
    await startUninstallCore(
      {
        db: env.DB,
        createJob: async (id, p) => {
          params = p;
          return { id };
        },
        newId: () => "x1",
      },
      { installId: "id1" },
    );
    if (params === null) throw new Error("no Workflow params");
    const p = params as UninstallJobParams;
    let error: unknown = null;
    try {
      await runUninstall({
        params: p,
        step,
        env: s.jobEnv,
        deps: { fetch: s.w.fetch, now: () => NOW },
      });
    } catch (e) {
      error = e;
    }
    return { params: p, error };
  }

  it("runs the destroy command, then removes the token and secrets from the sandbox Worker", async () => {
    const s = setup();
    await install(s);
    const r = await uninstall(s);
    expect(r.error).toBeNull();
    expect(r.params).toMatchObject({ selfDeploying: true, deleteResources: [] });
    expect(s.sandbox.runs.at(-1)).toMatchObject({
      runId: "destroy-1.0.0",
      command: ["pnpm", "alchemy", "destroy", "--yes"],
      sha: PIN,
      stage: STAGE,
    });
    expect(s.w.secretCalls.slice(-2)).toEqual([
      "DELETE APP_TOKEN_id1",
      "DELETE APP_SECRET_id1_ADMIN_PASSWORD",
    ]);
    // Appflare deleted nothing itself: no Cloudflare call touched the app's Workers.
    expect(s.w.account.state.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM resources WHERE install_id = 'id1' AND deleted_at IS NULL",
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await installRow("id1"))?.status).toBe("uninstalled");
  });

  it("deletes and logs each secret once when its step runs again after it finished", async () => {
    const s = setup();
    await install(s);
    const r = await uninstall(s, replayingStep("remove "));
    expect(r.error).toBeNull();
    expect(s.w.secretCalls.filter((c) => c.startsWith("DELETE"))).toEqual([
      "DELETE APP_TOKEN_id1",
      "DELETE APP_SECRET_id1_ADMIN_PASSWORD",
    ]);
    const messages = (await logsOf("x1")).map((l) => l.message);
    expect(messages.filter((m) => m.includes("APP_SECRET_id1_ADMIN_PASSWORD"))).toEqual([
      "Deleted the secret APP_SECRET_id1_ADMIN_PASSWORD from the sandbox Worker.",
    ]);
    expect(messages.filter((m) => m.includes("no longer had"))).toEqual([]);
  });

  it("fails when the destroy command leaves a Worker behind", async () => {
    const s = setup({ sandbox: { remaining: [JOBS] } });
    await install(s);
    const r = await uninstall(s);
    expect((await jobRow("x1"))?.error).toContain(`${JOBS} still exist`);
    expect(r.error).not.toBeNull();
    expect((await installRow("id1"))?.status).toBe("uninstalling");
    expect(s.w.secretCalls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("asks for the token again when the sandbox Worker lost it", async () => {
    const s = setup();
    await install(s);
    s.held.clear();
    await uninstall(s);
    expect((await jobRow("x1"))?.error).toMatch(
      /enter it again under \[Secrets in the app's settings\]/,
    );

    // Entering it again on the app's page puts it back where the job reads it.
    const stored = await replaceAppCredentialsCore(
      {
        db: env.DB,
        async putSandboxSecret(name) {
          s.held.add(name);
        },
      },
      { installId: "id1", appToken: "new-token", secrets: { ADMIN_PASSWORD: "again" } },
    );
    expect(stored.stored).toEqual(["app token", "ADMIN_PASSWORD"]);
    expect([...s.held].sort()).toEqual(["APP_SECRET_id1_ADMIN_PASSWORD", "APP_TOKEN_id1"]);
  });
});

describe("changing a self-deploying app's settings", () => {
  const NEW_SECRET = "new-admin-password-DO-NOT-LEAK";

  async function startChange(input: Partial<StartReconfigureInput>) {
    let params: ReconfigureJobParams | null = null;
    await startReconfigureCore(
      {
        db: env.DB,
        sandboxConnected: true,
        createJob: async (id, p) => {
          params = p;
          return { id };
        },
        newId: () => "r1",
      },
      { installId: "id1", ...input },
    );
    if (params === null) throw new Error("no Workflow params");
    return params as ReconfigureJobParams;
  }

  it("stores a new secret value on the sandbox Worker and runs the installer again at the installed pin", async () => {
    const s = setup();
    await install(s);
    // The catalog moved on; the change still deploys what is installed.
    s.catalog = selfDeployingCatalog({ pin: NEW_PIN });
    const params = await startChange({
      vars: { HOME_PAGE: "links" },
      secrets: { set: { ADMIN_PASSWORD: NEW_SECRET }, unset: [] },
      buildConfirmed: true,
    });
    const job = await jobRow("r1");
    expect(job?.input_json).not.toContain(NEW_SECRET);
    expect(JSON.parse(job?.input_json ?? "{}")).toMatchObject({
      selfDeploying: true,
      sandboxRun: "settings-r1",
      secrets: { set: ["ADMIN_PASSWORD"], unset: [] },
    });

    const step = fakeStep();
    await runReconfigure({
      params,
      step,
      env: s.jobEnv,
      deps: { fetch: s.w.fetch, now: () => NOW },
    });
    expect((await jobRow("r1"))?.status).toBe("succeeded");
    expect(s.w.secretCalls.at(-1)).toBe("PUT APP_SECRET_id1_ADMIN_PASSWORD");
    expect(s.sandbox.runs).toHaveLength(2);
    expect(s.sandbox.runs.at(-1)).toMatchObject({
      runId: "settings-r1",
      sha: PIN,
      stage: STAGE,
      vars: { HOME_PAGE: "links" },
      command: ["pnpm", "alchemy", "deploy", "--yes"],
    });
    expect(
      step.names.indexOf("store app secret ADMIN_PASSWORD on the sandbox Worker"),
    ).toBeLessThan(step.names.indexOf("deploy in sandbox"));
    const row = await installRow("id1");
    expect(row).toMatchObject({
      status: "installed",
      catalog_version: "1.0.0",
      pin_sha: PIN,
      config_json: '{"HOME_PAGE":"links"}',
    });
    const snapshots = await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots").first<{
      n: number;
    }>();
    expect(snapshots?.n).toBe(0);
    // This run's log is its own; the install's deploy log is kept too.
    expect(s.sandbox.cleanups.at(-1)).toEqual({
      installId: "id1",
      keepVersions: ["settings-r1", "deploy-1.0.0"],
    });
    const logs = await logsOf("r1");
    expect(JSON.stringify(logs)).not.toContain(NEW_SECRET);
    expect(JSON.stringify(s.sandbox.runs)).not.toContain(NEW_SECRET);
  });

  it("asks for the installer's cost, and never removes a secret the installer sets", async () => {
    const s = setup();
    await install(s);
    await expect(startChange({ vars: { HOME_PAGE: "links" } })).rejects.toThrow(
      /own installer applies the settings in your sandbox Worker\. Confirm its cost/,
    );
    await expect(
      startChange({ secrets: { set: {}, unset: ["ADMIN_PASSWORD"] }, buildConfirmed: true }),
    ).rejects.toThrow(/can be replaced, not removed/);
    expect((await installRow("id1"))?.status).toBe("installed");
  });
});
