import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import {
  SANDBOX_FEATURE_SELF_DEPLOYING_VOID,
  SANDBOX_PROTOCOL_VERSION,
  SELF_DEPLOYING_TOOLS,
  type SelfManagedDeployResult,
  type SelfManagedFailure,
  selfManagedOutcomeSchema,
} from "@appflare/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountReader, NamedResource } from "../discover";
import type { ExecOptions, ExecOutcome } from "../sandbox";
import { runSelfManaged, type SelfManagedAction } from "../self-managed";
import { FakeSandbox } from "../test/fake-sandbox";
import {
  chooseVoidDeployCommand,
  IMAGE_COREPACK_HOME,
  sha256Hex,
  VOID_HOME,
  voidEnv,
  voidResourceNames,
} from "./void";
import {
  EMPTY_REGISTRY,
  findVoidRecord,
  parseRegistrySnapshot,
  VOID_REGISTRY_DIR,
  type VoidRecord,
  type VoidRegistrySnapshot,
  voidRegistryKey,
} from "./void-registry";

// The container cannot run in tests: a FakeSandbox plays the registry script
// and a scripted Void CLI, with Miniflare's local R2 as the sandbox bucket
// and a scripted account reader in place of the Cloudflare API.

const SHA = "715beca2723f0f85417e89252487daac0660bef4";
const INSTALL = "01J8Z3Q4R5S6T7V8W9X0YZABCD";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "void-app-token-value-0123456789";
const TOKEN_ID = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const RECOVERY_KEY = "cmVjb3Zlcnkta2V5LXZhbHVlLTMyLWJ5dGVzLWxvbmc=";
const STAGE = "appflare-x0yzabcd";
const API = `void-${STAGE}-api`;
const PROXY = `void-${STAGE}-proxy`;
const INSTALLATION_ID = `${STAGE}-0123456789ab`;
const SNAPSHOT_FILE = "/workspace/appflare-build/void-registry.json";
const MANIFEST_PATH = `${ACCOUNT}/${INSTALLATION_ID}.json`;

const voidCommand = (...words: string[]) => ["pnpm", "exec", "void", "platform", ...words];
const COMMANDS = {
  discover: voidCommand("discover", "--account", "{{accountId}}", "--installation", "{{stage}}"),
  install: voidCommand(
    "install",
    "--yes",
    "--name",
    "{{stage}}",
    "--display-name",
    "Void",
    "--account",
    "{{accountId}}",
    "--workers-dev",
  ),
  resume: voidCommand("install", "--resume", "--yes", "--name", "{{stage}}"),
  update: voidCommand("upgrade", "{{stage}}", "--yes"),
  destroy: voidCommand("uninstall", "{{stage}}", "--purge-resources", "--yes"),
};
const LAUNCHED = (sub: keyof typeof COMMANDS) =>
  `with-node-24 ${COMMANDS[sub].join(" ").replaceAll("{{stage}}", STAGE).replaceAll("{{accountId}}", ACCOUNT)}`;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: INSTALL,
    runId: "deploy-1.1.11",
    accountId: ACCOUNT,
    tool: "void",
    repo: "appflare/void-platform",
    sha: SHA,
    ref: "main",
    packageManager: "pnpm",
    commands: COMMANDS,
    stage: STAGE,
    tokenEnv: [...SELF_DEPLOYING_TOOLS.void.tokenEnv],
    accountIdEnv: [...SELF_DEPLOYING_TOOLS.void.accountIdEnv],
    vars: { VOID_PLATFORM_ADMIN_GITHUB_LOGIN: "octocat" },
    secretNames: ["VOID_PLATFORM_RECOVERY_KEY"],
    expectedWorkers: [API, PROXY],
    ...overrides,
  };
}

function b64(text: string): string {
  return btoa(text);
}

/** A Void installation manifest file as the CLI writes it. */
function manifest(
  status: string,
  opts: {
    runtime?: boolean;
    updatedAt?: string;
    desiredState?: string;
    deletedResource?: boolean;
  } = {},
): string {
  return b64(
    JSON.stringify({
      account: { id: ACCOUNT, name: "Acme" },
      deployment: { installationSlug: STAGE, displayName: "Void" },
      desiredState: opts.desiredState ?? "enabled",
      id: INSTALLATION_ID,
      resources: [
        { key: "routing-kv", kind: "kv-namespace", state: "ready" },
        ...(opts.deletedResource ? [{ key: "assets", kind: "r2-bucket", state: "deleted" }] : []),
      ],
      runtime: opts.runtime ? { manifestSha256: "a".repeat(64), source: "package" } : null,
      status,
      updatedAt: opts.updatedAt ?? "2026-10-15T12:00:00.000Z",
    }),
  );
}

function snapshot(files: Record<string, string>): VoidRegistrySnapshot {
  return { ...EMPTY_REGISTRY, files };
}

type VoidCli = (
  sub: string,
  registry: Map<string, string>,
  env: Readonly<Record<string, string>>,
) => { exitCode?: number; output?: string } | undefined;

/**
 * The container with a registry directory (path to base64) that the
 * registry script restores and saves, and a scripted Void CLI.
 */
class FakeVoidSandbox extends FakeSandbox {
  readonly registry = new Map<string, string>();
  readonly voidRuns: string[] = [];

  constructor(private readonly cli: VoidCli = () => undefined) {
    super({ bucket: env.BUILDS, refHead: SHA, packOutput: {} });
  }

  override async exec(command: string, options: ExecOptions): Promise<ExecOutcome> {
    const done = (exitCode = 0, output = ""): ExecOutcome => {
      if (output) options.onOutput(output);
      return {
        exitCode,
        stdout: exitCode === 0 ? output : "",
        stderr: exitCode === 0 ? "" : output,
      };
    };
    if (command.includes("void-registry.cjs restore")) {
      this.commands.push(command);
      const saved = parseRegistrySnapshot(this.written.get(SNAPSHOT_FILE) ?? "");
      this.registry.clear();
      for (const [path, data] of Object.entries(saved.files)) this.registry.set(path, data);
      return done();
    }
    if (command.includes("void-registry.cjs save")) {
      this.commands.push(command);
      this.readable.set(SNAPSHOT_FILE, JSON.stringify(snapshot(Object.fromEntries(this.registry))));
      return done();
    }
    const cli = /^with-node-24 pnpm exec void platform (\S+)/.exec(command);
    if (cli?.[1] !== undefined) {
      this.commands.push(command);
      this.voidRuns.push(cli[1]);
      if (options.env) this.envs.push(options.env);
      const answer = this.cli(cli[1], this.registry, options.env ?? {});
      return done(answer?.exitCode ?? 0, answer?.output ?? "");
    }
    return super.exec(command, options);
  }
}

/** A Void CLI whose install, resume and update leave the installation `status` (installed by default). */
function cliLeaving(status = "installed"): VoidCli {
  return (sub, registry) => {
    if (sub === "install" || sub === "upgrade") {
      registry.set(MANIFEST_PATH, manifest(status, { runtime: status === "installed" }));
    }
    if (sub === "uninstall") registry.set(MANIFEST_PATH, manifest("uninstalled"));
    return undefined;
  };
}

function fakeAccount(
  opts: {
    tokenIdFails?: unknown;
    namespaces?: NamedResource[];
    configs?: NamedResource[];
    gateways?: NamedResource[];
    workers?: Record<string, unknown[]>;
  } = {},
): AccountReader & { calls: string[] } {
  const calls: string[] = [];
  const workers = opts.workers ?? {
    [API]: [
      { type: "dispatch_namespace", name: "USER_WORKERS", namespace: `void-${STAGE}-users` },
      { type: "hyperdrive", name: "DATABASE", id: "hd-1" },
      { type: "kv_namespace", name: "ROUTING", namespace_id: "kv-1" },
      { type: "r2_bucket", name: "ASSETS", bucket_name: `void-${STAGE}-assets` },
      { type: "queue", name: "DEPLOYMENTS", queue_name: `void-${STAGE}-deployments` },
    ],
    [PROXY]: [{ type: "kv_namespace", name: "ROUTING", namespace_id: "kv-1" }],
  };
  return {
    calls,
    async workerBindings(worker) {
      calls.push(`bindings ${worker}`);
      return workers[worker] ?? null;
    },
    async workersDevEnabled(worker) {
      return worker === API;
    },
    async accountSubdomain() {
      return "acme";
    },
    async d1Names() {
      return new Map();
    },
    async kvTitles() {
      return new Map([["kv-1", `void-${STAGE}-routing`]]);
    },
    async dispatchNamespaces() {
      calls.push("dispatch namespaces");
      return (
        opts.namespaces ?? [
          { id: "ns-1", name: `void-${STAGE}-users` },
          { id: "ns-2", name: "someone-else-users" },
        ]
      );
    },
    async hyperdriveConfigs() {
      calls.push("hyperdrive list");
      return (
        opts.configs ?? [
          { id: "hd-1", name: `void-${STAGE}-database` },
          // Another installation whose name only starts like this one's.
          { id: "hd-2", name: `void-${STAGE}x-database` },
        ]
      );
    },
    async aiGateways() {
      calls.push("ai gateway list");
      return opts.gateways ?? [{ id: `void-${STAGE}`, name: `void-${STAGE}` }];
    },
    async tokenId() {
      calls.push("token verify");
      if (opts.tokenIdFails !== undefined) throw opts.tokenIdFails;
      return TOKEN_ID;
    },
  };
}

function run(
  action: SelfManagedAction,
  sandbox: FakeVoidSandbox,
  opts: { input?: Record<string, unknown>; account?: AccountReader } = {},
) {
  const opened: string[] = [];
  let clock = Date.parse("2026-10-15T12:00:00Z");
  const promise = runSelfManaged(action, opts.input ?? request(), {
    bucket: env.BUILDS,
    sandboxVersion: "0.5.0",
    openSandbox: (id) => {
      opened.push(id);
      return sandbox;
    },
    credentials: () => ({ token: TOKEN, secrets: { VOID_PLATFORM_RECOVERY_KEY: RECOVERY_KEY } }),
    account: () => opts.account ?? fakeAccount(),
    now: () => {
      clock += 3_000;
      return clock;
    },
    flushIntervalMs: 60_000,
  });
  return { promise, opened };
}

function asDeploy(outcome: unknown): SelfManagedDeployResult {
  const parsed = selfManagedOutcomeSchema.parse(outcome);
  if (!parsed.ok) throw new Error(`expected a result, got ${parsed.step}: ${parsed.message}`);
  if (parsed.action !== "deploy") throw new Error("expected a deploy");
  return parsed;
}

function asFailure(outcome: unknown): SelfManagedFailure {
  const parsed = selfManagedOutcomeSchema.parse(outcome);
  if (parsed.ok) throw new Error("expected a failure");
  return parsed;
}

async function saved(): Promise<VoidRegistrySnapshot | null> {
  const object = await env.BUILDS.get(voidRegistryKey(INSTALL));
  return object === null ? null : parseRegistrySnapshot(await object.text());
}

async function save(files: Record<string, string>): Promise<void> {
  await env.BUILDS.put(voidRegistryKey(INSTALL), JSON.stringify(snapshot(files)));
}

afterEach(() => reset());

describe("chooseVoidDeployCommand", () => {
  const record = (status: string, over: Partial<Omit<VoidRecord, "status">> = {}): VoidRecord => ({
    id: INSTALLATION_ID,
    status,
    hasRuntime: false,
    desiredState: "enabled",
    hasDeletedResources: false,
    updatedAt: "",
    ...over,
  });
  const pick = (r: VoidRecord | null) => {
    const choice = chooseVoidDeployCommand(r, STAGE);
    return "refused" in choice ? "refused" : choice.command;
  };
  const UNFINISHED = [
    "planned",
    "provisioning",
    "waiting-for-dns",
    "waiting-for-oauth",
    "deploying",
    "verifying",
    "failed",
  ];

  it("installs when there is no installation and updates an installed one", () => {
    expect(pick(null)).toBe("install");
    expect(pick(record("installed", { hasRuntime: true }))).toBe("update");
    // Records of older CLI versions may lack a runtime once installed.
    expect(pick(record("installed"))).toBe("update");
  });

  it("resumes a first install that did not finish, as the Void CLI counts one in progress", () => {
    for (const status of UNFINISHED) expect(pick(record(status)), status).toBe("resume");
  });

  it("updates again when an update did not finish: the installation has a runtime", () => {
    // An update passes through provisioning and deploying too, and pauses for
    // a sandbox drain; `install --resume` refuses a deployed installation.
    for (const status of UNFINISHED) {
      expect(pick(record(status, { hasRuntime: true })), status).toBe("update");
    }
    const paused = chooseVoidDeployCommand(record("deploying", { hasRuntime: true }), STAGE);
    expect("reason" in paused && paused.reason).toBe(
      `The last update of the Void installation ${STAGE} did not finish (status "deploying"): running the update command again.`,
    );
  });

  it("resumes a draft, the one command the CLI takes for a name a record holds", () => {
    expect(pick(record("draft"))).toBe("resume");
    expect(pick(record("draft", { hasRuntime: true }))).toBe("refused");
  });

  it("refuses what the CLI does not count as an install in progress, saying why", () => {
    for (const status of ["disabled", "disabling", "uninstalling", "something-new"]) {
      expect(pick(record(status, { hasRuntime: true })), status).toBe("refused");
    }
    const turnedOff = chooseVoidDeployCommand(
      record("provisioning", { desiredState: "disabled" }),
      STAGE,
    );
    expect("refused" in turnedOff && turnedOff.refused).toContain("turned off");
    const removed = chooseVoidDeployCommand(record("failed", { hasDeletedResources: true }), STAGE);
    expect("refused" in removed && removed.refused).toContain(
      "uninstall the app in Appflare to finish it",
    );
  });

  it("explains each choice in a log line", () => {
    const fresh = chooseVoidDeployCommand(null, STAGE);
    expect("reason" in fresh && fresh.reason).toBe(
      `No Void installation named ${STAGE} yet: running the install command.`,
    );
    const paused = chooseVoidDeployCommand(record("waiting-for-dns"), STAGE);
    expect("reason" in paused && paused.reason).toContain('(status "waiting-for-dns")');
  });
});

describe("the Void registry", () => {
  it("finds the record of the stage in the account, ignoring uninstalled ones and other files", () => {
    const files = {
      "registry.json": b64("{}"),
      [MANIFEST_PATH]: manifest("installed", { runtime: true }),
      [`${ACCOUNT}/${INSTALLATION_ID}.recovery.enc`]: b64('{"ciphertext":"x"}'),
      [`${ACCOUNT}/${STAGE}-ffffffffffff.json`]: manifest("uninstalled", {
        updatedAt: "2026-10-16T00:00:00.000Z",
      }),
      [`${"f".repeat(32)}/${INSTALLATION_ID}.json`]: manifest("failed"),
    };
    expect(findVoidRecord(snapshot(files), ACCOUNT, STAGE)).toEqual({
      id: INSTALLATION_ID,
      status: "installed",
      hasRuntime: true,
      desiredState: "enabled",
      hasDeletedResources: false,
      updatedAt: "2026-10-15T12:00:00.000Z",
    });
    const halfRemoved = snapshot({
      [MANIFEST_PATH]: manifest("failed", { desiredState: "disabled", deletedResource: true }),
    });
    expect(findVoidRecord(halfRemoved, ACCOUNT, STAGE)).toMatchObject({
      desiredState: "disabled",
      hasDeletedResources: true,
    });
    expect(findVoidRecord(snapshot(files), ACCOUNT, "appflare-other")).toBeNull();
    expect(findVoidRecord(EMPTY_REGISTRY, ACCOUNT, STAGE)).toBeNull();
  });

  it("accepts only snapshots whose paths stay inside the directory", () => {
    expect(parseRegistrySnapshot(JSON.stringify(snapshot({ "a/b.json": "" }))).files).toEqual({
      "a/b.json": "",
    });
    for (const path of ["../escape", "/etc/passwd", "a/../../b", "a//b"]) {
      expect(() => parseRegistrySnapshot(JSON.stringify(snapshot({ [path]: "" })))).toThrow();
    }
    expect(() => parseRegistrySnapshot("not json")).toThrow("not JSON");
  });
});

describe("the Void CLI's environment", () => {
  it("adds HOME, the registry and the R2 keys to the installer's environment", async () => {
    const secret = await sha256Hex(TOKEN);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const base = { CI: "1", CLOUDFLARE_API_TOKEN: TOKEN };
    expect(voidEnv(base, { accessKeyId: TOKEN_ID, secretAccessKey: secret })).toEqual({
      CI: "1",
      CLOUDFLARE_API_TOKEN: TOKEN,
      HOME: VOID_HOME,
      COREPACK_HOME: IMAGE_COREPACK_HOME,
      VOID_PLATFORM_REGISTRY_DIR: VOID_REGISTRY_DIR,
      VOID_PLATFORM_R2_ACCESS_KEY_ID: TOKEN_ID,
      VOID_PLATFORM_R2_SECRET_ACCESS_KEY: secret,
    });
    expect(voidResourceNames(STAGE)).toEqual({
      dispatch_namespace: [`void-${STAGE}-users`],
      hyperdrive: [`void-${STAGE}-database`],
      ai_gateway: [`void-${STAGE}`],
      kv: [`void-${STAGE}-routing`, `void-${STAGE}-isr-cache`, `void-${STAGE}-legacy-assets`],
      r2: [`void-${STAGE}-assets`],
      queue: [
        `void-${STAGE}-usage-events`,
        `void-${STAGE}-cron-fires`,
        `void-${STAGE}-deployments`,
      ],
    });
  });
});

describe("a Void deploy", () => {
  it("discovers, installs with Node 24, saves the registry and records what Void created", async () => {
    const sandbox = new FakeVoidSandbox(cliLeaving("installed"));
    const account = fakeAccount();
    const result = asDeploy(await run("deploy", sandbox, { account }).promise);

    expect(sandbox.voidRuns).toEqual(["discover", "install"]);
    const commands = sandbox.commands.filter((c) => !c.startsWith("<"));
    expect(commands).toContain(
      "with-node-24 pnpm install --frozen-lockfile --ignore-scripts --config.package-manager-strict=false",
    );
    expect(commands).toContain(LAUNCHED("discover"));
    expect(commands.at(-2)).toBe(LAUNCHED("install"));
    // The registry is saved after each Void command, and restored before them.
    const restore = commands.findIndex((c) => c.includes("void-registry.cjs restore"));
    expect(restore).toBeLessThan(commands.indexOf(LAUNCHED("discover")));
    expect(commands.at(-1)).toContain("void-registry.cjs save");
    expect(commands.filter((c) => c.includes("void-registry.cjs save"))).toHaveLength(2);
    expect(findVoidRecord((await saved()) ?? EMPTY_REGISTRY, ACCOUNT, STAGE)?.status).toBe(
      "installed",
    );

    // The token id is read before the container starts, and only for Void.
    expect(account.calls[0]).toBe("token verify");
    const voidEnvs = sandbox.envs.filter((e) => e.VOID_PLATFORM_REGISTRY_DIR !== undefined);
    expect(voidEnvs).toHaveLength(2);
    expect(voidEnvs[1]).toMatchObject({
      CLOUDFLARE_API_TOKEN: TOKEN,
      VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      VOID_PLATFORM_ADMIN_GITHUB_LOGIN: "octocat",
      VOID_PLATFORM_RECOVERY_KEY: RECOVERY_KEY,
      HOME: VOID_HOME,
      VOID_PLATFORM_REGISTRY_DIR: VOID_REGISTRY_DIR,
      VOID_PLATFORM_R2_ACCESS_KEY_ID: TOKEN_ID,
      VOID_PLATFORM_R2_SECRET_ACCESS_KEY: await sha256Hex(TOKEN),
      CI: "1",
    });
    // Nothing but the Void commands sees a credential.
    const others = sandbox.envs.filter((e) => e.VOID_PLATFORM_REGISTRY_DIR === undefined);
    expect(others.every((e) => e.CLOUDFLARE_API_TOKEN === undefined)).toBe(true);

    expect(result.log).toContain(
      `The registry has no record of the Void installation ${STAGE}: running the discover command`,
    );
    expect(result.log).toContain(
      `No Void installation named ${STAGE} yet: running the install command.`,
    );
    expect(result.log).toContain(`The Void installation ${STAGE} is installed.`);

    const summary = result.resources.map((r) => `${r.kind} ${r.name} ${r.worker} ${r.binding}`);
    expect(summary).toEqual([
      `worker ${API} ${API} null`,
      `worker ${PROXY} ${PROXY} null`,
      `kv void-${STAGE}-routing ${API} ROUTING`,
      `r2 void-${STAGE}-assets ${API} ASSETS`,
      `queue void-${STAGE}-deployments ${API} DEPLOYMENTS`,
      `dispatch_namespace void-${STAGE}-users ${API} USER_WORKERS`,
      `hyperdrive void-${STAGE}-database ${API} DATABASE`,
      `ai_gateway void-${STAGE} ${API} null`,
    ]);
    expect(result.resources.find((r) => r.kind === "dispatch_namespace")?.cfId).toBe("ns-1");
    expect(result.resources.find((r) => r.kind === "hyperdrive")?.cfId).toBe("hd-1");
    expect(result.resources.find((r) => r.kind === "ai_gateway")?.cfId).toBeNull();
  });

  it("keeps the token and the derived R2 secret out of the log and the failure", async () => {
    const secret = await sha256Hex(TOKEN);
    const leaky: VoidCli = (sub, registry) => {
      if (sub === "install") {
        registry.set(MANIFEST_PATH, manifest("installed", { runtime: true }));
        return { output: `token=${TOKEN} r2=${secret}\n` };
      }
      return undefined;
    };
    const result = asDeploy(await run("deploy", new FakeVoidSandbox(leaky)).promise);
    expect(result.log).toContain("token=[redacted] r2=[redacted]");
    expect(result.log).not.toContain(secret);
    const stored = await env.BUILDS.get(result.logKey as string);
    expect(await stored?.text()).not.toContain(secret);

    await env.BUILDS.delete(voidRegistryKey(INSTALL));
    const failing: VoidCli = (sub) =>
      sub === "install" ? { exitCode: 1, output: `refused ${secret} ${TOKEN}\n` } : undefined;
    const failure = asFailure(await run("deploy", new FakeVoidSandbox(failing)).promise);
    expect(failure).toMatchObject({ step: "deploy", exitCode: 1, retryable: false });
    expect(failure.message).toContain("the Void install command failed (exit code 1)");
    expect(failure.message).not.toContain(secret);
    expect(failure.message).not.toContain(TOKEN);
  });

  it("updates an installation the saved registry records as installed, without discovering", async () => {
    await save({ [MANIFEST_PATH]: manifest("installed", { runtime: true }) });
    const sandbox = new FakeVoidSandbox(cliLeaving("installed"));
    const result = asDeploy(await run("deploy", sandbox).promise);
    expect(sandbox.voidRuns).toEqual(["upgrade"]);
    expect(sandbox.commands).toContain(LAUNCHED("update"));
    expect(result.log).toContain(
      `The Void installation ${STAGE} is installed: running the update command.`,
    );
  });

  it("continues an update that stopped part way with the update command, not resume", async () => {
    await save({ [MANIFEST_PATH]: manifest("deploying", { runtime: true }) });
    const sandbox = new FakeVoidSandbox(cliLeaving("installed"));
    const result = asDeploy(await run("deploy", sandbox).promise);
    expect(sandbox.voidRuns).toEqual(["upgrade"]);
    expect(sandbox.commands).not.toContain(LAUNCHED("resume"));
    expect(result.log).toContain('did not finish (status "deploying"): running the update command');
  });

  it("resumes an install that stopped, and fails when Void stops again without an error", async () => {
    await save({ [MANIFEST_PATH]: manifest("waiting-for-dns") });
    const sandbox = new FakeVoidSandbox((sub, registry) => {
      if (sub === "install") {
        registry.set(
          MANIFEST_PATH,
          manifest("waiting-for-dns", { updatedAt: "2026-10-15T13:00:00.000Z" }),
        );
      }
      return undefined;
    });
    const failure = asFailure(await run("deploy", sandbox).promise);
    expect(sandbox.commands).toContain(LAUNCHED("resume"));
    expect(failure).toMatchObject({ step: "deploy", retryable: false, exitCode: null });
    expect(failure.message).toContain(
      `the installation ${STAGE} is "waiting-for-dns", not installed`,
    );
    // What Void recorded is saved for the next run.
    expect(findVoidRecord((await saved()) ?? EMPTY_REGISTRY, ACCOUNT, STAGE)?.updatedAt).toBe(
      "2026-10-15T13:00:00.000Z",
    );
  });

  it("saves the registry after a failing command, and reports the command's failure", async () => {
    const sandbox = new FakeVoidSandbox((sub, registry) => {
      if (sub !== "install") return undefined;
      registry.set(MANIFEST_PATH, manifest("provisioning"));
      registry.set(`${ACCOUNT}/${INSTALLATION_ID}.secrets.enc`, b64('{"ciphertext":"c"}'));
      return { exitCode: 1, output: "platform: Hyperdrive could not reach the database\n" };
    });
    const failure = asFailure(await run("deploy", sandbox).promise);
    expect(failure).toMatchObject({ step: "deploy", exitCode: 1 });
    expect(failure.message).toContain("Hyperdrive could not reach the database");
    const kept = (await saved()) ?? EMPTY_REGISTRY;
    expect(Object.keys(kept.files).sort()).toEqual([
      `${ACCOUNT}/${INSTALLATION_ID}.json`,
      `${ACCOUNT}/${INSTALLATION_ID}.secrets.enc`,
    ]);
    expect(failure.log).toContain("Saved the Void registry as the failed command left it");

    // The next run restores it and resumes.
    const next = new FakeVoidSandbox(cliLeaving("installed"));
    asDeploy(await run("deploy", next).promise);
    expect(next.voidRuns).toEqual(["install"]);
    expect(next.commands).toContain(LAUNCHED("resume"));
  });

  it("surfaces a failing discover command instead of installing", async () => {
    const sandbox = new FakeVoidSandbox((sub) =>
      sub === "discover"
        ? {
            exitCode: 1,
            output: "platform: Routing namespace x does not match its ownership manifest.\n",
          }
        : undefined,
    );
    const failure = asFailure(await run("deploy", sandbox).promise);
    expect(failure).toMatchObject({ step: "deploy", exitCode: 1 });
    expect(failure.message).toContain("the Void discover command failed");
    expect(sandbox.voidRuns).toEqual(["discover"]);
  });

  it("refuses a turned-off installation without running a Void command", async () => {
    await save({ [MANIFEST_PATH]: manifest("disabled", { runtime: true }) });
    const sandbox = new FakeVoidSandbox();
    const failure = asFailure(await run("deploy", sandbox).promise);
    expect(failure).toMatchObject({ step: "deploy", retryable: false });
    expect(failure.message).toContain("turned off");
    expect(sandbox.voidRuns).toEqual([]);
  });

  it("starts from an empty registry when the saved one cannot be read", async () => {
    await env.BUILDS.put(voidRegistryKey(INSTALL), "{broken");
    const sandbox = new FakeVoidSandbox(cliLeaving("installed"));
    const result = asDeploy(await run("deploy", sandbox).promise);
    expect(result.log).toContain("cannot be read (it is not JSON); starting from an empty one");
    expect(sandbox.voidRuns).toEqual(["discover", "install"]);
  });

  it("fails the token step before any container when the token's id cannot be read", async () => {
    const refused = new CloudflareApiError({
      status: 401,
      method: "GET",
      path: `/accounts/${ACCOUNT}/tokens/verify`,
      errors: [{ code: 1000, message: "Invalid API Token" }],
    });
    const { promise, opened } = run("deploy", new FakeVoidSandbox(), {
      account: fakeAccount({ tokenIdFails: refused }),
    });
    const failure = asFailure(await promise);
    expect(failure).toMatchObject({ step: "token", retryable: false });
    expect(failure.message).toContain("Void's R2 access key is derived from it");
    expect(opened).toEqual([]);

    const offline = asFailure(
      await run("deploy", new FakeVoidSandbox(), {
        account: fakeAccount({ tokenIdFails: new Error("network connection lost") }),
      }).promise,
    );
    expect(offline).toMatchObject({ step: "token", retryable: true });
  });
});

describe("a Void destroy", () => {
  it("runs the destroy command and deletes the saved registry", async () => {
    await save({ [MANIFEST_PATH]: manifest("installed", { runtime: true }) });
    const sandbox = new FakeVoidSandbox(cliLeaving());
    const outcome = selfManagedOutcomeSchema.parse(
      await run("destroy", sandbox, {
        input: request({ runId: "destroy-1.1.11" }),
        account: fakeAccount({ workers: {} }),
      }).promise,
    );
    expect(outcome).toMatchObject({ ok: true, action: "destroy", remaining: [] });
    expect(sandbox.voidRuns).toEqual(["uninstall"]);
    expect(sandbox.commands).toContain(LAUNCHED("destroy"));
    expect(await saved()).toBeNull();
  });

  it("discovers a missing record first, and skips the destroy command when there is no installation", async () => {
    const sandbox = new FakeVoidSandbox();
    const outcome = selfManagedOutcomeSchema.parse(
      await run("destroy", sandbox, {
        input: request({ runId: "destroy-1.1.11" }),
        account: fakeAccount({ workers: {} }),
      }).promise,
    );
    expect(outcome).toMatchObject({ ok: true, action: "destroy" });
    expect(sandbox.voidRuns).toEqual(["discover"]);
    expect(outcome.log).toContain("nothing for the destroy command to remove");
    expect(await saved()).toBeNull();
  });

  it("keeps the registry and fails when the destroy command leaves the installation not uninstalled", async () => {
    await save({ [MANIFEST_PATH]: manifest("installed", { runtime: true }) });
    const sandbox = new FakeVoidSandbox((sub, registry) => {
      if (sub === "uninstall") registry.set(MANIFEST_PATH, manifest("failed", { runtime: true }));
      return undefined;
    });
    const failure = asFailure(
      await run("destroy", sandbox, { input: request({ runId: "destroy-1.1.11" }) }).promise,
    );
    expect(failure).toMatchObject({ step: "destroy", retryable: false, exitCode: null });
    expect(failure.message).toContain(`the installation ${STAGE} is "failed", not uninstalled`);
    expect(findVoidRecord((await saved()) ?? EMPTY_REGISTRY, ACCOUNT, STAGE)?.status).toBe(
      "failed",
    );
  });

  it("keeps the registry when the destroy command fails", async () => {
    await save({ [MANIFEST_PATH]: manifest("installed", { runtime: true }) });
    const sandbox = new FakeVoidSandbox((sub, registry) => {
      if (sub !== "uninstall") return undefined;
      registry.set(MANIFEST_PATH, manifest("uninstalling", { runtime: true }));
      return { exitCode: 1, output: "platform: Remove the platform's projects first.\n" };
    });
    const failure = asFailure(
      await run("destroy", sandbox, { input: request({ runId: "destroy-1.1.11" }) }).promise,
    );
    expect(failure).toMatchObject({ step: "destroy", exitCode: 1 });
    expect(findVoidRecord((await saved()) ?? EMPTY_REGISTRY, ACCOUNT, STAGE)?.status).toBe(
      "uninstalling",
    );
  });
});

describe("the SandboxBuilds entrypoint", () => {
  it("advertises that it runs the Void CLI", async () => {
    expect((await exports.default.info()).features).toContain(SANDBOX_FEATURE_SELF_DEPLOYING_VOID);
  });
});
