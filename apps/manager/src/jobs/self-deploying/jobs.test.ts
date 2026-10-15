import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type CatalogManifest,
  catalogManifestSchema,
  type IndexApp,
  SANDBOX_FEATURE_SELF_DEPLOYING,
  SANDBOX_FEATURE_SELF_DEPLOYING_VOID,
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
import { LOGS_ON } from "../../test/workers-logs";
import { writeAppSpendSettings } from "../../usage/store/app-settings.server";
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
    info?: FakeSandboxOptions["info"];
  } = {},
): Setup {
  const held = new Set<string>();
  const state: { catalog: CatalogManifest } = { catalog: selfDeployingCatalog() };
  const sandbox = fakeSandbox(null, {
    selfManaged: { held, ...opts.sandbox },
    versionIds: opts.versionIds,
    ...(opts.info === undefined ? {} : { info: opts.info }),
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
      sandboxConnected: async () => true,
      createJob: async (id, p) => {
        if (p.kind === "install") params = p;
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
          sandboxConnected: async () => false,
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
          sandboxConnected: async () => true,
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

describe("installing an app with the Void CLI", () => {
  const voidCommand = (...words: string[]) => ["pnpm", "exec", "void", "platform", ...words];
  const commands = {
    discoverCommand: voidCommand(
      "discover",
      "--account",
      "{{accountId}}",
      "--installation",
      "{{stage}}",
    ),
    installCommand: voidCommand("install", "--yes", "--name", "{{stage}}", "--workers-dev"),
    resumeCommand: voidCommand("install", "--resume", "--yes", "--name", "{{stage}}"),
    updateCommand: voidCommand("upgrade", "{{stage}}", "--yes"),
    destroyCommand: voidCommand("uninstall", "{{stage}}", "--purge-resources", "--yes"),
  };

  function voidCatalog(): CatalogManifest {
    const alchemy = selfDeployingCatalog();
    return catalogManifestSchema.parse({
      ...alchemy,
      install: {
        tier: "self-deploying",
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        selfDeploying: {
          tool: "void",
          ...commands,
          workerNames: ["cut-{{stage}}", "cut-{{stage}}-jobs"],
        },
      },
      requires: ["containers", "workers-for-platforms"],
    });
  }

  it("hands the sandbox Worker every command, and records the namespace and gateway it reports", async () => {
    const s = setup({
      info: {
        protocol: SANDBOX_PROTOCOL_VERSION,
        sandboxVersion: "0.5.0",
        image: "docker.io/mendylanda/appflare-sandbox:0.5.0",
        features: [SANDBOX_FEATURE_SELF_DEPLOYING, SANDBOX_FEATURE_SELF_DEPLOYING_VOID],
      },
      sandbox: {
        deploy: (request) => ({
          ok: true,
          action: "deploy",
          protocol: SANDBOX_PROTOCOL_VERSION,
          sandboxVersion: "0.4.0",
          minutes: 9,
          logKey: null,
          log: "",
          image: "docker.io/mendylanda/appflare-sandbox:0.4.0",
          installId: request.installId,
          workers: request.expectedWorkers.map((name, i) => ({
            name,
            url: i === 0 ? `https://${name}.acme.workers.dev` : null,
          })),
          resources: [
            { kind: "worker", name: MAIN, cfId: MAIN, worker: MAIN, binding: null },
            {
              kind: "dispatch_namespace",
              name: `void-${STAGE}-users`,
              cfId: "ns-1",
              worker: MAIN,
              binding: "USER_WORKERS",
            },
            { kind: "ai_gateway", name: `void-${STAGE}`, cfId: null, worker: MAIN, binding: null },
          ],
        }),
      },
    });
    s.catalog = voidCatalog();
    const r = await install(s);
    expect(r.error).toBeNull();
    expect(s.sandbox.runs[0]).toMatchObject({
      tool: "void",
      stage: STAGE,
      accountId: ACC,
      commands: {
        discover: commands.discoverCommand,
        install: commands.installCommand,
        resume: commands.resumeCommand,
        update: commands.updateCommand,
        destroy: commands.destroyCommand,
      },
      tokenEnv: ["CLOUDFLARE_API_TOKEN", "VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN"],
    });
    const rows = (
      await env.DB.prepare(
        "SELECT kind, name, managed_by FROM resources WHERE install_id = 'id1' AND kind != 'secret' ORDER BY rowid",
      ).all<{ kind: string; name: string; managed_by: string }>()
    ).results;
    expect(rows.map((x) => `${x.kind} ${x.name} ${x.managed_by}`)).toEqual([
      `worker ${MAIN} app`,
      `dispatch_namespace void-${STAGE}-users app`,
      `ai_gateway void-${STAGE} app`,
    ]);
  });

  it("refuses a sandbox Worker that cannot run the Void CLI, before running anything", async () => {
    const s = setup();
    s.catalog = voidCatalog();
    const started = await startInstall(s);
    const old = fakeSandbox(null, {
      selfManaged: { held: s.held },
      info: {
        protocol: 1,
        sandboxVersion: "0.4.0",
        image: "docker.io/mendylanda/appflare-sandbox:0.4.0",
        features: [SANDBOX_FEATURE_SELF_DEPLOYING],
      },
    });
    await expect(
      runInstall({
        params: started.params,
        step: fakeStep(),
        env: { ...s.jobEnv, SANDBOX: old },
        deps: { fetch: s.w.fetch, now: () => NOW, sleep: async () => {} },
      }),
    ).rejects.toThrow(/cannot run the Void CLI/);
    expect(old.runs).toEqual([]);
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
      sandboxConnected: async () => true,
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

  /** Workers Logs on with sampling of their own, as an admin may set them in the dashboard. */
  const SAMPLED = {
    ...LOGS_ON,
    head_sampling_rate: 0.5,
    logs: { enabled: true, head_sampling_rate: 0.25, persist: true, invocation_logs: false },
  };

  /**
   * An installed app whose `MAIN` Worker has `SAMPLED` and `JOBS` none,
   * and an installer that deploys with the app's own configuration: it
   * drops `MAIN`'s setting and turns `JOBS`'s on.
   */
  async function changedByInstaller() {
    const s = setup();
    await install(s);
    const account = s.w.account.state;
    account.observability[MAIN] = SAMPLED;
    account.observability[JOBS] = null;
    const push = s.sandbox.runs.push.bind(s.sandbox.runs);
    s.sandbox.runs.push = (...runs) => {
      account.observability[MAIN] = null;
      account.observability[JOBS] = LOGS_ON;
      return push(...runs);
    };
    const params = await startUpdate(s);
    account.calls.length = 0;
    return { s, account, params };
  }

  it("puts back the whole Workers Logs setting the installer changed", async () => {
    const { s, account, params } = await changedByInstaller();
    const step = fakeStep();
    await runUpdate({ params, step, env: s.jobEnv, deps: { fetch: s.w.fetch, now: () => NOW } });
    expect((await jobRow("u1"))?.status).toBe("succeeded");
    // One step per Worker, each one or two calls.
    expect(step.names.filter((n) => n.includes("Workers Logs"))).toEqual([
      `read Workers Logs of ${MAIN}`,
      `read Workers Logs of ${JOBS}`,
      `keep Workers Logs of ${MAIN}`,
      `keep Workers Logs of ${JOBS}`,
    ]);
    expect(account.calls.filter((c) => c.includes("script-settings"))).toEqual([
      `GET /workers/scripts/${MAIN}/script-settings`,
      `GET /workers/scripts/${JOBS}/script-settings`,
      `GET /workers/scripts/${MAIN}/script-settings`,
      `PATCH /workers/scripts/${MAIN}/script-settings`,
      `GET /workers/scripts/${JOBS}/script-settings`,
      `PATCH /workers/scripts/${JOBS}/script-settings`,
    ]);
    // The sampling too, not only on.
    expect(account.observability[MAIN]).toEqual(SAMPLED);
    // Off: no block, as Cloudflare answers.
    expect(account.observability[JOBS]).toBeNull();
    const messages = (await logsOf("u1")).map((l) => l.message);
    expect(messages).toContain(
      `The installer changed Workers Logs of ${MAIN} (off after it ran); they are on again, as they were.`,
    );
    expect(messages).toContain(
      `The installer changed Workers Logs of ${JOBS} (on after it ran); they are off again, as they were.`,
    );
  });

  it("puts them back when a step after the installer fails", async () => {
    const { s, account, params } = await changedByInstaller();
    await expect(
      runUpdate({
        params,
        step: fakeStep({ failing: ["record new version"] }),
        env: s.jobEnv,
        deps: { fetch: s.w.fetch, now: () => NOW },
      }),
    ).rejects.toThrow("record new version");
    expect((await jobRow("u1"))?.status).toBe("failed");
    expect(account.observability[MAIN]).toEqual(SAMPLED);
    expect(account.observability[JOBS]).toBeNull();
  });

  it("names the Worker and the setting to restore when it cannot put them back", async () => {
    const { s, account, params } = await changedByInstaller();
    account.failOnce.set(`PATCH /workers/scripts/${MAIN}/script-settings`, 403);
    await expect(
      runUpdate({
        params,
        step: fakeStep({ failing: ["record new version"] }),
        env: s.jobEnv,
        deps: { fetch: s.w.fetch, now: () => NOW },
      }),
    ).rejects.toThrow("record new version");
    const warnings = (await logsOf("u1")).filter((l) => l.level === "warn").map((l) => l.message);
    expect(warnings).toContainEqual(
      expect.stringContaining(
        `Turn Workers Logs on for ${MAIN} in the app's Usage tab: the installer may have changed them, and Appflare could not put them back.`,
      ),
    );
    expect(account.observability[MAIN]).toBeNull();
    // The other Worker is put back all the same.
    expect(account.observability[JOBS]).toBeNull();
  });

  it("stops before the installer when Cloudflare does not say whether Workers Logs are on", async () => {
    const s = setup();
    await install(s);
    s.w.account.state.observability[MAIN] = LOGS_ON;
    s.w.account.state.failOnce.set(`GET /workers/scripts/${MAIN}/script-settings`, 403);
    const runs = s.sandbox.runs.length;
    const params = await startUpdate(s);
    await expect(
      runUpdate({
        params,
        step: fakeStep(),
        env: s.jobEnv,
        deps: { fetch: s.w.fetch, now: () => NOW },
      }),
    ).rejects.toThrow("read Workers Logs");
    const job = await jobRow("u1");
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain(
      `read Workers Logs of ${MAIN}: Appflare could not read whether Workers Logs are on for ${MAIN}`,
    );
    expect(s.sandbox.runs).toHaveLength(runs);
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

  it("refuses an update once the entry ships a release instead, saying to reinstall", async () => {
    const s = setup();
    await install(s);
    // The entry moved from its own installer to a release Appflare deploys.
    const app: IndexApp = {
      ...(await indexApp(selfDeployingCatalog(), "1.1.0")),
      tier: "artifact",
    };
    const created: string[] = [];
    await expect(
      startUpdateCore(
        {
          db: env.DB,
          loadApp: async () => app,
          loadManifest: async () => {
            throw new Error("not reached");
          },
          sandboxConnected: async () => true,
          createJob: async (id: string) => {
            created.push(id);
            return { id };
          },
        },
        { installId: "id1" },
      ),
    ).rejects.toThrow(
      "Cut changed how it is installed (it no longer ships its own installer). Uninstall it and install it again.",
    );
    expect(created).toEqual([]);
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
    await writeAppSpendSettings(createDb(env.DB), "id1", { autoPause: "on" }, { userId: "u1" });
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
    // The app's spend protection goes with it.
    const spend = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM app_spend_settings WHERE install_id = 'id1'",
    ).first<{ n: number }>();
    expect(spend?.n).toBe(0);
  });

  /** A container application behind the app's Durable Object, and a queue it consumes. */
  function leaveRunning(s: Setup) {
    const state = s.w.account.state;
    state.containerApps = [
      { id: "ca-1", name: "cut-box", namespaceId: "ns-box" },
      { id: "ca-2", name: "someone-else-box", namespaceId: "ns-theirs" },
    ];
    state.doNamespaces = [
      { id: "ns-box", script: MAIN, class: "Box" },
      { id: "ns-theirs", script: "someone-else", class: "Box" },
    ];
    state.queues = [{ queue_id: "q-1", queue_name: "cut-jobs" }];
    state.consumers = { "q-1": [{ consumer_id: "c-1", type: "worker", script_name: JOBS }] };
  }

  it("records what may outlive the destroy, and deletes what the destroy left behind", async () => {
    const s = setup();
    await install(s);
    leaveRunning(s);
    const step = fakeStep();
    const r = await uninstall(s, step);
    expect(r.error).toBeNull();
    const names = step.names;
    const destroy = names.indexOf("destroy in sandbox");
    // Found before the destroy, while the Workers and their namespaces exist.
    for (const found of [
      "check queues for consumers",
      "check consumers of queue cut-jobs",
      "check container applications",
    ]) {
      expect(names.indexOf(found)).toBeGreaterThan(-1);
      expect(names.indexOf(found)).toBeLessThan(destroy);
    }
    expect(names.indexOf(`remove consumer of queue cut-jobs from ${JOBS}`)).toBeGreaterThan(
      destroy,
    );
    expect(names.indexOf("delete container application cut-box")).toBeGreaterThan(destroy);
    const state = s.w.account.state;
    expect(state.containerApps).toEqual([
      { id: "ca-2", name: "someone-else-box", namespaceId: "ns-theirs" },
    ]);
    expect(state.consumers["q-1"]).toEqual([]);
    const warnings = (await logsOf("x1")).filter((l) => l.level === "warn").map((l) => l.message);
    expect(warnings).toEqual([
      `The installer's destroy command left the queue "cut-jobs" delivering to Worker "${JOBS}"; removed that consumer.`,
      `The installer's destroy command left the container application "cut-box" running; deleted it, and its instances stop with it.`,
    ]);
    expect((await installRow("id1"))?.status).toBe("uninstalled");
  });

  it("has nothing left to delete when the destroy removed them", async () => {
    const s = setup({
      sandbox: {
        onDestroy: () => {
          const state = s.w.account.state;
          state.containerApps = (state.containerApps ?? []).filter((a) => a.id !== "ca-1");
          state.consumers["q-1"] = [];
        },
      },
    });
    await install(s);
    leaveRunning(s);
    const r = await uninstall(s);
    expect(r.error).toBeNull();
    const logs = await logsOf("x1");
    expect(logs.filter((l) => l.level === "warn")).toEqual([]);
    expect(logs.map((l) => l.message)).toEqual(
      expect.arrayContaining([
        `The installer's destroy command removed the consumer of the queue "cut-jobs".`,
        `The installer's destroy command deleted the container application "cut-box".`,
      ]),
    );
    expect(s.w.account.state.containerApps).toEqual([
      { id: "ca-2", name: "someone-else-box", namespaceId: "ns-theirs" },
    ]);
  });

  it("looks no further on Workers Free, where Cloudflare refuses Containers", async () => {
    const s = setup();
    await install(s);
    const r = await uninstall(s);
    expect(r.error).toBeNull();
    const calls = s.w.account.state.calls;
    expect(calls.some((c) => c.includes("/containers/applications"))).toBe(true);
    expect(calls.some((c) => c.includes("/workers/durable_objects/namespaces"))).toBe(false);
    expect((await logsOf("x1")).map((l) => l.message)).toContain(
      "Cloudflare runs containers only on Workers Paid and refuses them to this account, so the app has no container applications.",
    );
  });

  it("warns on Workers Paid when Cloudflare answers 401 for Containers, and goes on", async () => {
    const s = setup();
    await install(s);
    await writeSettings(createDb(env.DB), { [SETTING.accountPlan]: "paid" });
    // Cloudflare answers 401, as it does to an account off Workers Paid.
    s.w.account.state.containerApps = null;
    s.w.account.state.doNamespaces = [{ id: "ns-box", script: MAIN, class: "Box" }];
    const r = await uninstall(s);
    expect(r.error).toBeNull();
    const logs = await logsOf("x1");
    expect(logs.map((l) => l.message)).not.toContain(
      "Cloudflare runs containers only on Workers Paid and refuses them to this account, so the app has no container applications.",
    );
    expect(logs.filter((l) => l.level === "warn").map((l) => l.message)).toEqual([
      "Cloudflare answered 401 when asked for the account's container applications: on Workers Paid that means it did not accept Appflare's API token for Containers, so Appflare could not check whether a container application runs behind the app's Durable Objects (Box). If Workers > Containers in the Cloudflare dashboard lists one for this app, delete it there: it keeps running, and billing, once the Worker is gone.",
    ]);
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

  for (const failing of [[], ["record settings"]]) {
    it(`puts back the Workers Logs the installer changed${failing.length > 0 ? ", also when a later step fails" : ""}`, async () => {
      const s = setup();
      await install(s);
      const account = s.w.account.state;
      account.observability[MAIN] = LOGS_ON;
      const push = s.sandbox.runs.push.bind(s.sandbox.runs);
      s.sandbox.runs.push = (...runs) => {
        account.observability[MAIN] = null;
        return push(...runs);
      };
      const params = await startChange({ vars: { HOME_PAGE: "links" }, buildConfirmed: true });
      const run = runReconfigure({
        params,
        step: fakeStep({ failing }),
        env: s.jobEnv,
        deps: { fetch: s.w.fetch, now: () => NOW },
      });
      if (failing.length > 0) await expect(run).rejects.toThrow("record settings");
      else await run;
      expect((await jobRow("r1"))?.status).toBe(failing.length > 0 ? "failed" : "succeeded");
      expect(account.observability[MAIN]).toEqual(LOGS_ON);
    });
  }

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
