import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  SANDBOX_FEATURE_SELF_DEPLOYING,
  SANDBOX_PROTOCOL_VERSION,
  type SelfManagedDeployResult,
  type SelfManagedDestroyResult,
  type SelfManagedFailure,
  selfManagedOutcomeSchema,
} from "@appflare/schema";
import { afterEach, describe, expect, it } from "vitest";
import { type AccountReader, accountReader, discover } from "./discover";
import { readProgress } from "./log";
import { BUILD_ENV, selfManagedSandboxId } from "./protocol";
import {
  type HeldCredentials,
  heldCredentials,
  runSelfManaged,
  type SelfManagedAction,
  selfManagedStatus,
} from "./self-managed";
import { type FakeFailure, FakeSandbox } from "./test/fake-sandbox";

// The container cannot run in tests: every run here uses FakeSandbox, with
// Miniflare's local R2 as the BUILDS bucket and a scripted account reader in
// place of the Cloudflare API.

const SHA = "84e4705503ceaef54d1b284c167de9942563cdae";
const INSTALL = "01J8Z3Q4R5S6T7V8W9X0YZABCD";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "app-token-value-0123456789";
const API_KEY = "dataforseo-secret-value";
const STAGE = "appflare-x0yzabcd";
const APP = `open-seo-${STAGE}`;
const AUDIT = `open-seo-${STAGE}-audit`;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: INSTALL,
    runId: "deploy-0.1.9",
    accountId: ACCOUNT,
    tool: "alchemy",
    repo: "every-app/open-seo",
    sha: SHA,
    ref: "v0.1.9",
    packageManager: "pnpm",
    buildCommand: ["pnpm", "exec", "vite", "build", "--mode", "selfhost"],
    command: ["pnpm", "alchemy", "deploy", "--yes"],
    stage: STAGE,
    stageArg: "--stage",
    tokenEnv: ["CLOUDFLARE_API_TOKEN"],
    accountIdEnv: ["CLOUDFLARE_ACCOUNT_ID"],
    vars: { ACCESS_ALLOWED_EMAILS: "admin@example.com" },
    secretNames: ["DATAFORSEO_API_KEY"],
    expectedWorkers: [APP, AUDIT],
    ...overrides,
  };
}

/** A scripted account as the app token sees it after the installer ran. */
function fakeAccount(
  workers: Record<string, unknown[]>,
  opts: { failWith?: string } = {},
): AccountReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async workerBindings(worker) {
      calls.push(`bindings ${worker}`);
      if (opts.failWith !== undefined) throw new Error(opts.failWith);
      return workers[worker] ?? null;
    },
    async workersDevEnabled(worker) {
      calls.push(`subdomain ${worker}`);
      return worker === APP;
    },
    async accountSubdomain() {
      calls.push("account subdomain");
      return "acme";
    },
    async d1Names() {
      calls.push("d1 list");
      return new Map([["d1-uuid", `open-seo-db-${STAGE}`]]);
    },
    async kvTitles() {
      calls.push("kv list");
      return new Map([
        ["kv-1", `open-seo-kv-${STAGE}`],
        ["kv-2", `open-seo-oauth-kv-${STAGE}`],
      ]);
    },
  };
}

const DEPLOYED: Record<string, unknown[]> = {
  [AUDIT]: [
    { type: "d1", name: "DB", id: "d1-uuid" },
    { type: "kv_namespace", name: "KV", namespace_id: "kv-1" },
    { type: "r2_bucket", name: "R2", bucket_name: `open-seo-r2-${STAGE}` },
    {
      type: "durable_object_namespace",
      name: "AUDIT_SCRATCHPAD",
      class_name: "AuditScratchpad",
      namespace_id: "do-1",
    },
    {
      type: "workflow",
      name: "SITE_AUDIT_WORKFLOW",
      workflow_name: `site-audit-workflow-${STAGE}`,
      class_name: "SiteAuditWorkflow",
    },
    { type: "secret_text", name: "DATAFORSEO_API_KEY" },
  ],
  [APP]: [
    { type: "d1", name: "DB", id: "d1-uuid" },
    { type: "kv_namespace", name: "KV", namespace_id: "kv-1" },
    { type: "kv_namespace", name: "OAUTH_KV", namespace_id: "kv-2" },
    { type: "r2_bucket", name: "R2", bucket_name: `open-seo-r2-${STAGE}` },
    {
      type: "durable_object_namespace",
      name: "CHAT",
      class_name: "ChatAgent",
      namespace_id: "do-2",
    },
    {
      type: "workflow",
      name: "RANK_CHECK_WORKFLOW",
      workflow_name: `rank-check-workflow-${STAGE}`,
      class_name: "RankCheckWorkflow",
    },
    // Implemented by the audit Worker: that Worker's, not this one's.
    {
      type: "workflow",
      name: "SITE_AUDIT_WORKFLOW",
      workflow_name: `site-audit-workflow-${STAGE}`,
      class_name: "SiteAuditWorkflow",
      script_name: AUDIT,
    },
    { type: "service", name: "AUDIT_ENGINE", service: AUDIT },
    { type: "ratelimit", name: "MCP_RATE_LIMIT", namespace_id: "1001" },
    { type: "assets", name: "ASSETS" },
  ],
};

const DOTENV = "/workspace/appflare-build/source/.env";
/** Deletes a `.env` Alchemy would read before the environment, printing its path when there was one. */
const DOTENV_REMOVAL = `if [ -e ${DOTENV} ] || [ -L ${DOTENV} ]; then rm -rf -- ${DOTENV} && echo ${DOTENV}; fi`;

const HELD: HeldCredentials = { token: TOKEN, secrets: { DATAFORSEO_API_KEY: API_KEY } };

function fake(
  opts: {
    failures?: FakeFailure[];
    outputs?: Array<{ match: RegExp; output: string }>;
    destroyThrows?: string;
  } = {},
) {
  return new FakeSandbox({ bucket: env.BUILDS, refHead: SHA, packOutput: {}, ...opts });
}

function run(
  action: SelfManagedAction,
  /** The container each open returns, in order; the last one again after that. */
  sandbox: FakeSandbox | FakeSandbox[],
  opts: {
    input?: Record<string, unknown>;
    held?: HeldCredentials;
    account?: AccountReader;
  } = {},
) {
  const opened: string[] = [];
  const accounts: Array<{ token: string; accountId: string }> = [];
  let clock = Date.parse("2026-09-24T12:00:00Z");
  const promise = runSelfManaged(action, opts.input ?? request(), {
    bucket: env.BUILDS,
    sandboxVersion: "0.4.0",
    openSandbox: (id) => {
      opened.push(id);
      const list = Array.isArray(sandbox) ? sandbox : [sandbox];
      const next = list[Math.min(opened.length, list.length) - 1];
      if (next === undefined) throw new Error("no fake container to open");
      return next;
    },
    credentials: () => opts.held ?? HELD,
    account: (token, accountId) => {
      accounts.push({ token, accountId });
      return opts.account ?? fakeAccount(DEPLOYED);
    },
    now: () => {
      clock += 3_000;
      return clock;
    },
    flushIntervalMs: 60_000,
  });
  return { promise, opened, accounts };
}

function asFailure(outcome: unknown): SelfManagedFailure {
  const parsed = selfManagedOutcomeSchema.parse(outcome);
  if (parsed.ok) throw new Error("expected a failure");
  return parsed;
}

function asDeploy(outcome: unknown): SelfManagedDeployResult {
  const parsed = selfManagedOutcomeSchema.parse(outcome);
  if (!parsed.ok) throw new Error(`expected a result, got ${parsed.step}: ${parsed.message}`);
  if (parsed.action !== "deploy") throw new Error("expected a deploy");
  return parsed;
}

function asDestroy(outcome: unknown): SelfManagedDestroyResult {
  const parsed = selfManagedOutcomeSchema.parse(outcome);
  if (!parsed.ok) throw new Error(`expected a result, got ${parsed.step}: ${parsed.message}`);
  if (parsed.action !== "destroy") throw new Error("expected a destroy");
  return parsed;
}

afterEach(() => reset());

describe("deploySelfManaged", () => {
  it("checks out, installs, builds without credentials, deploys with the app token, and reports what it created", async () => {
    const sandbox = fake();
    const { promise, opened, accounts } = run("deploy", sandbox);
    const result = asDeploy(await promise);

    expect(opened).toEqual([await selfManagedSandboxId(INSTALL)]);
    expect(sandbox.commands).toEqual([
      "rm -rf /workspace/appflare-build && mkdir -p /workspace/appflare-build",
      "<gitCheckout https://github.com/every-app/open-seo.git v0.1.9>",
      "git -C /workspace/appflare-build/source rev-parse HEAD",
      "pnpm install --frozen-lockfile --ignore-scripts --config.package-manager-strict=false",
      "pnpm exec vite build --mode selfhost",
      DOTENV_REMOVAL,
      `pnpm alchemy deploy --yes --stage ${STAGE}`,
    ]);
    // Every command but the installer's runs in the credential-free build environment.
    expect(
      sandbox.envs.slice(0, -1).every((e) => JSON.stringify(e) === JSON.stringify(BUILD_ENV)),
    ).toBe(true);
    expect(sandbox.envs.at(-1)).toEqual({
      ...BUILD_ENV,
      ACCESS_ALLOWED_EMAILS: "admin@example.com",
      DATAFORSEO_API_KEY: API_KEY,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_API_TOKEN: TOKEN,
    });
    expect(sandbox.destroyed).toBe(true);
    // The account is read with the app's token, for the requested account.
    expect(accounts).toEqual([{ token: TOKEN, accountId: ACCOUNT }]);

    expect(result.workers).toEqual([
      { name: APP, url: `https://${APP}.acme.workers.dev` },
      { name: AUDIT, url: null },
    ]);
    const summary = result.resources.map((r) => `${r.kind} ${r.name} ${r.worker}`);
    expect(summary).toEqual([
      `worker ${APP} ${APP}`,
      `worker ${AUDIT} ${AUDIT}`,
      `d1 open-seo-db-${STAGE} ${APP}`,
      `kv open-seo-kv-${STAGE} ${APP}`,
      `kv open-seo-oauth-kv-${STAGE} ${APP}`,
      `r2 open-seo-r2-${STAGE} ${APP}`,
      `durable_object ChatAgent ${APP}`,
      `workflow rank-check-workflow-${STAGE} ${APP}`,
      `durable_object AuditScratchpad ${AUDIT}`,
      `workflow site-audit-workflow-${STAGE} ${AUDIT}`,
    ]);
    expect(result.resources.find((r) => r.kind === "d1")?.cfId).toBe("d1-uuid");

    const progress = await readProgress(env.BUILDS, result.logKey as string);
    expect(result.logKey).toBe(`builds/${INSTALL}/deploy-0.1.9/log.txt`);
    expect(progress).toMatchObject({ state: "succeeded", stage: "discover" });
  });

  it("deletes a .env the checkout or the build left before the installer runs", async () => {
    const sandbox = fake({ outputs: [{ match: /rm -rf -- .*\.env/, output: `${DOTENV}\n` }] });
    const result = asDeploy(await run("deploy", sandbox).promise);
    expect(sandbox.commands.indexOf(DOTENV_REMOVAL)).toBe(sandbox.commands.length - 2);
    expect(result.log).toContain(`Removed ${DOTENV}`);
    // In a subdirectory, the project's .env and the checkout root's both go.
    const nested = fake();
    asDeploy(await run("deploy", nested, { input: request({ subdirectory: "apps/web" }) }).promise);
    const removal = nested.commands.at(-2) ?? "";
    expect(removal).toContain("/workspace/appflare-build/source/apps/web/.env");
    expect(removal).toContain(`rm -rf -- ${DOTENV} `);
  });

  it("runs a later attempt in a container of its own", async () => {
    const { promise, opened } = run("deploy", fake(), { input: request({ attempt: 2 }) });
    asDeploy(await promise);
    expect(opened).toEqual([`${await selfManagedSandboxId(INSTALL)}-a2`]);
    expect(await selfManagedSandboxId(INSTALL, 2)).toBe(opened[0]);
  });

  it("starts again in a fresh container, once, when a new version of the Worker resets the first as it starts", async () => {
    const RESET =
      "Sandbox operation sandbox.exec was interrupted while the platform was updating the sandbox runtime";
    const first = fake({
      failures: [{ match: /^rm -rf /, throws: RESET }],
      // Stopping the reset container fails too; that is not the run's problem.
      destroyThrows: "Durable Object reset because its code was updated",
    });
    const fresh = fake();
    const { promise, opened } = run("deploy", [first, fresh]);
    const result = asDeploy(await promise);

    const id = await selfManagedSandboxId(INSTALL);
    expect(opened).toEqual([id, `${id}-r`]);
    expect(first.commands).toEqual([
      "rm -rf /workspace/appflare-build && mkdir -p /workspace/appflare-build",
    ]);
    expect(fresh.commands[0]).toBe(first.commands[0]);
    expect(fresh.commands.at(-1)).toBe(`pnpm alchemy deploy --yes --stage ${STAGE}`);
    expect(fresh.destroyed).toBe(true);
    // A note in the run's log, not a failure.
    expect(result.log).toContain("starting again in a fresh container");
    expect(result.log).not.toContain("FAILED");
    expect(result.log).not.toContain("Stopping the container failed");

    // The fresh container is reset too: the run fails, retryably, as before.
    const again = asFailure(
      await run("deploy", [
        fake({ failures: [{ match: /^rm -rf /, throws: RESET }] }),
        fake({ failures: [{ match: /^rm -rf /, throws: RESET }] }),
      ]).promise,
    );
    expect(again).toMatchObject({ step: "checkout", retryable: true });

    // Only the first call starts over: a reset later in the run fails it.
    const later = fake({
      failures: [
        { match: /pnpm install/, throws: "Durable Object reset because its code was updated" },
      ],
    });
    const cut = run("deploy", [later, fake()]);
    expect(asFailure(await cut.promise)).toMatchObject({ step: "install", retryable: true });
    expect(cut.opened).toEqual([id]);
  });

  it("keeps the token and secrets out of the log and the failure message", async () => {
    const sandbox = fake({
      outputs: [{ match: /alchemy deploy/, output: `using token ${TOKEN}\nkey=${API_KEY}\n` }],
      failures: [],
    });
    const result = asDeploy(await run("deploy", sandbox).promise);
    expect(result.log).not.toContain(TOKEN);
    expect(result.log).not.toContain(API_KEY);
    expect(result.log).toContain("using token [redacted]");
    const stored = await env.BUILDS.get(result.logKey as string);
    expect(await stored?.text()).not.toContain(TOKEN);

    const failing = fake({
      failures: [{ match: /alchemy deploy/, exitCode: 1, output: `401 for ${TOKEN}\n` }],
    });
    const failure = asFailure(await run("deploy", failing).promise);
    expect(failure).toMatchObject({ step: "deploy", exitCode: 1, retryable: false });
    expect(failure.message).toContain("the installer's deploy command failed (exit code 1)");
    expect(failure.message).not.toContain(TOKEN);
    expect(failure.log).not.toContain(TOKEN);
  });

  it("refuses to start without the app token or a secret, before any container", async () => {
    for (const held of [
      { token: null, secrets: HELD.secrets },
      { token: TOKEN, secrets: {} },
    ]) {
      const { promise, opened } = run("deploy", fake(), { held });
      const failure = asFailure(await promise);
      expect(failure).toMatchObject({ step: "token", retryable: false });
      expect(failure.message).toMatch(/enter the app's (token|secrets) again/);
      expect(opened).toEqual([]);
    }
  });

  it("reports a failing build as the build step, without running the installer", async () => {
    const sandbox = fake({ failures: [{ match: /vite build/, exitCode: 2, output: "boom\n" }] });
    const failure = asFailure(await run("deploy", sandbox).promise);
    expect(failure).toMatchObject({ step: "build", exitCode: 2 });
    expect(sandbox.commands.some((c) => c.includes("alchemy"))).toBe(false);
  });

  it("fails the discover step when an expected Worker is missing, and retries an unreadable account", async () => {
    const partial = asFailure(
      await run("deploy", fake(), {
        account: fakeAccount({ [APP]: DEPLOYED[APP] ?? [] }),
      }).promise,
    );
    expect(partial).toMatchObject({ step: "discover", retryable: false });
    expect(partial.message).toContain(`no Worker ${AUDIT}`);

    const unreadable = asFailure(
      await run("deploy", fake(), {
        account: fakeAccount(DEPLOYED, { failWith: `403 Forbidden ${TOKEN}` }),
      }).promise,
    );
    expect(unreadable).toMatchObject({ step: "discover", retryable: true });
    expect(unreadable.message).not.toContain(TOKEN);
  });

  it("refuses an invalid request without starting a container", async () => {
    const { promise, opened } = run("deploy", fake(), {
      input: request({ vars: { CLOUDFLARE_API_TOKEN: "x" } }),
    });
    const failure = asFailure(await promise);
    expect(failure).toMatchObject({ step: "request", logKey: null });
    expect(opened).toEqual([]);
  });
});

describe("destroySelfManaged", () => {
  it("runs the destroy command with the stage, then reports which Workers remain", async () => {
    const sandbox = fake();
    const gone = asDestroy(
      await run("destroy", sandbox, {
        input: request({
          runId: "destroy-0.1.9",
          command: ["pnpm", "alchemy", "destroy", "--yes"],
        }),
        account: fakeAccount({}),
      }).promise,
    );
    expect(sandbox.commands.at(-1)).toBe(`pnpm alchemy destroy --yes --stage ${STAGE}`);
    expect(gone.remaining).toEqual([]);

    const left = asDestroy(
      await run("destroy", fake(), {
        input: request({
          runId: "destroy-0.1.9",
          command: ["pnpm", "alchemy", "destroy", "--yes"],
        }),
        account: fakeAccount({ [AUDIT]: [] }),
      }).promise,
    );
    expect(left.remaining).toEqual([AUDIT]);
  });
});

describe("custody and status", () => {
  it("reads the token and secrets from the Worker's own per-install secrets", () => {
    const names = ["DATAFORSEO_API_KEY"];
    expect(
      heldCredentials(
        {
          [`APP_TOKEN_${INSTALL}`]: TOKEN,
          [`APP_SECRET_${INSTALL}_DATAFORSEO_API_KEY`]: API_KEY,
          [`APP_SECRET_${INSTALL}_UNASKED`]: "not requested",
        },
        INSTALL,
        names,
      ),
    ).toEqual(HELD);
    expect(heldCredentials({}, INSTALL, names)).toEqual({ token: null, secrets: {} });
    // Another install's token and secrets are not this one's.
    expect(
      heldCredentials(
        { APP_TOKEN_OTHER: TOKEN, APP_SECRET_OTHER_DATAFORSEO_API_KEY: API_KEY },
        INSTALL,
        names,
      ),
    ).toEqual({ token: null, secrets: {} });
  });

  it("reports what the Worker holds and which Workers exist", async () => {
    const statusRequest = {
      protocol: SANDBOX_PROTOCOL_VERSION,
      installId: INSTALL,
      accountId: ACCOUNT,
      secretNames: ["DATAFORSEO_API_KEY"],
      expectedWorkers: [APP, AUDIT],
    };
    const deps = {
      sandboxVersion: "0.4.0",
      credentials: () => HELD,
      account: () => fakeAccount({ [APP]: [] }),
    };
    expect(await selfManagedStatus(statusRequest, deps)).toEqual({
      protocol: SANDBOX_PROTOCOL_VERSION,
      sandboxVersion: "0.4.0",
      tokenPresent: true,
      secretsPresent: true,
      workers: [{ name: APP, url: `https://${APP}.acme.workers.dev` }],
      problem: null,
    });
    const without = await selfManagedStatus(statusRequest, {
      ...deps,
      credentials: () => ({ token: null, secrets: {} }),
    });
    expect(without).toMatchObject({ tokenPresent: false, secretsPresent: false, workers: null });
  });

  it("is served over RPC by the SandboxBuilds entrypoint, which advertises the feature", async () => {
    const builds = exports.default;
    expect((await builds.info()).features).toContain(SANDBOX_FEATURE_SELF_DEPLOYING);
    // No token is held in the test Worker's environment.
    const failure = asFailure(await builds.deploySelfManaged(request()));
    expect(failure).toMatchObject({ step: "token", action: "deploy" });
    const status = await builds.selfManagedStatus({
      protocol: SANDBOX_PROTOCOL_VERSION,
      installId: INSTALL,
      accountId: ACCOUNT,
      secretNames: [],
      expectedWorkers: [APP],
    });
    expect(status).toMatchObject({ tokenPresent: false, secretsPresent: true, workers: null });
  });
});

describe("accountReader", () => {
  it("reads bindings, subdomains and names from the Cloudflare API with the app token", async () => {
    const seen: string[] = [];
    const reader = accountReader(TOKEN, ACCOUNT, async (input, init) => {
      const url = new URL(input);
      seen.push(`${init?.method ?? "GET"} ${url.pathname}`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      const ok = (result: unknown) =>
        Response.json({ success: true, errors: [], messages: [], result });
      if (url.pathname.endsWith(`/workers/scripts/${AUDIT}/bindings`)) {
        return Response.json(
          { success: false, errors: [{ code: 10007, message: "not found" }], messages: [] },
          { status: 404 },
        );
      }
      if (url.pathname.endsWith("/bindings")) return ok([{ type: "d1", name: "DB", id: "u1" }]);
      if (url.pathname.endsWith(`/workers/scripts/${APP}/subdomain`)) return ok({ enabled: true });
      if (url.pathname.endsWith("/workers/subdomain")) return ok({ subdomain: "acme" });
      if (url.pathname.endsWith("/d1/database")) return ok([{ uuid: "u1", name: "db-name" }]);
      throw new Error(`unexpected ${url.pathname}`);
    });
    const found = await discover(reader, [APP, AUDIT]);
    expect(found.missing).toEqual([AUDIT]);
    expect(found.resources.map((r) => `${r.kind} ${r.name} ${r.cfId}`)).toEqual([
      `worker ${APP} ${APP}`,
      "d1 db-name u1",
    ]);
    expect(seen.every((s) => s.startsWith(`GET /client/v4/accounts/${ACCOUNT}/`))).toBe(true);
  });
});
