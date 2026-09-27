import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { createHash } from "node:crypto";
import {
  type BuildFailure,
  type BuildResult,
  buildOutcomeSchema,
  SANDBOX_FEATURE_ASSETS_ONLY,
  SANDBOX_FEATURE_CONFIG_PATCH,
  SANDBOX_FEATURE_D1_BASELINE,
  SANDBOX_FEATURE_D1_SEED,
  SANDBOX_FEATURE_GITHUB_TOKENS,
  SANDBOX_FEATURE_INSTALL_DIRS,
  SANDBOX_FEATURE_REPOSITORY,
  SANDBOX_FEATURE_SELF_DEPLOYING,
  SANDBOX_FEATURE_WRANGLER_CONFIG_INLINE,
  SANDBOX_PROTOCOL_VERSION,
} from "@appflare/schema";
import { afterEach, describe, expect, it } from "vitest";
import { runBuild } from "./build";
import { readProgress } from "./log";
import {
  BUILD_ENV,
  freshSandboxId,
  MANIFEST_INPUT,
  MAX_SANDBOX_ID_LENGTH,
  STAGE_TIMEOUTS,
  sandboxId,
} from "./protocol";
import { deleteInstallBuilds } from "./storage";
import { type FakeFailure, FakeSandbox } from "./test/fake-sandbox";

// The container cannot run in tests: every build here runs against
// FakeSandbox, with Miniflare's local R2 as the BUILDS bucket.

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";

const catalogManifest = {
  slug: "widget",
  name: "Widget",
  summary: "A widget.",
  homepage: "https://github.com/acme/widget",
  repo: "acme/widget",
  license: "MIT",
  categories: ["utilities"],
  maintainers: ["acme"],
  source: { ref: "v1.2.3", sha: SHA },
  install: {
    tier: "sandbox",
    packageManager: "pnpm",
    wranglerConfig: "wrangler.jsonc",
    workerName: "widget",
  },
  plan: "paid",
  requires: ["containers"],
  secrets: [],
  vars: [],
  postInstall: [],
  tokenPermissions: [],
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: "01J8INSTALL",
    version: "1.2.3",
    repo: "acme/widget",
    sha: SHA,
    wranglerConfigPath: "wrangler.jsonc",
    catalogManifest,
    ...overrides,
  };
}

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);

/** The one Worker module of the test artifact: bytes 4..9 of ZIP. */
const MODULE = {
  name: "index.js",
  type: "esm",
  path: "worker/index.js",
  offset: 4,
  size: 6,
  sha256: createHash("sha256").update(ZIP.subarray(4, 10)).digest("hex"),
};

function packedManifest(overrides: Record<string, unknown> = {}): Uint8Array {
  const manifest = {
    format: 1,
    app: "widget",
    version: "1.2.3",
    source: { repo: "acme/widget", sha: SHA, ref: "v1.2.3" },
    builtAt: "2026-09-23T12:00:00.000Z",
    builder: "@appflare/pack@0.2.0",
    keyId: "unsigned",
    worker: {
      name: "widget",
      mainModule: "index.js",
      compatibilityDate: "2026-09-01",
      compatibilityFlags: [],
      modules: [MODULE],
      bindings: [],
      migrations: [],
      crons: [],
      observability: null,
      placement: null,
      limits: null,
    },
    assets: { config: {}, binding: null, files: [] },
    d1Migrations: {},
    catalog: catalogManifest,
    ...overrides,
  };
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

function fake(
  options: Partial<ConstructorParameters<typeof FakeSandbox>[0]> & {
    failures?: FakeFailure[];
  } = {},
): FakeSandbox {
  return new FakeSandbox({
    bucket: env.BUILDS,
    refHead: SHA,
    packOutput: { "widget-1.2.3.zip": ZIP, "manifest.json": packedManifest() },
    ...options,
  });
}

function build(
  /** The container each open returns, in order; the last one again after that. */
  sandbox: FakeSandbox | FakeSandbox[],
  input: Record<string, unknown> = request(),
) {
  const opened: { id: string; instanceType: string }[] = [];
  let clock = Date.parse("2026-09-23T12:00:00Z");
  const promise = runBuild(input, {
    bucket: env.BUILDS,
    sandboxVersion: "0.1.0",
    openSandbox: (id, instanceType) => {
      opened.push({ id, instanceType });
      const list = Array.isArray(sandbox) ? sandbox : [sandbox];
      const next = list[Math.min(opened.length, list.length) - 1];
      if (next === undefined) throw new Error("no fake container to open");
      return next;
    },
    // Every reading of the clock moves it 3 s on.
    now: () => {
      clock += 3_000;
      return clock;
    },
    flushIntervalMs: 60_000,
  });
  return { promise, opened };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function asFailure(outcome: unknown): BuildFailure {
  const parsed = buildOutcomeSchema.parse(outcome);
  if (parsed.ok) throw new Error("expected a failure");
  return parsed;
}

function asResult(outcome: unknown): BuildResult {
  const parsed = buildOutcomeSchema.parse(outcome);
  if (!parsed.ok) throw new Error(`expected a result, got: ${parsed.stage}: ${parsed.message}`);
  return parsed;
}

afterEach(() => reset());

function withBuildCommand(command: string): Record<string, unknown> {
  return { ...catalogManifest, install: { ...catalogManifest.install, buildCommand: command } };
}

describe("runBuild", () => {
  it("builds, stores the unsigned artifact under builds/<install>/<version>/, and destroys the container", async () => {
    const sandbox = fake();
    const { promise, opened } = build(
      sandbox,
      request({
        buildCommand: ["pnpm", "build"],
        catalogManifest: withBuildCommand("pnpm build"),
      }),
    );
    const result = asResult(await promise);

    expect(opened).toEqual([
      { id: await sandboxId("01J8INSTALL", SHA), instanceType: "standard-1" },
    ]);
    expect(result).toMatchObject({
      protocol: SANDBOX_PROTOCOL_VERSION,
      sandboxVersion: "0.1.0",
      image: "docker.io/mendylanda/appflare-sandbox:0.1.0",
      installId: "01J8INSTALL",
      version: "1.2.3",
      size: ZIP.byteLength,
      manifestKey: "builds/01J8INSTALL/1.2.3/manifest.json",
      artifactKey: "builds/01J8INSTALL/1.2.3/widget-1.2.3.zip",
      logKey: "builds/01J8INSTALL/1.2.3/log.txt",
    });
    expect(result.digest).toBe(await sha256Hex(packedManifest()));
    expect(result.minutes).toBeGreaterThan(0);
    expect(sandbox.destroyed).toBe(true);

    // The steps, in order, with the exact commands.
    expect(sandbox.commands).toEqual([
      "rm -rf /workspace/appflare-build && mkdir -p /workspace/appflare-build",
      "<gitCheckout https://github.com/acme/widget.git v1.2.3>",
      "git -C /workspace/appflare-build/source rev-parse HEAD",
      "pnpm install --frozen-lockfile --ignore-scripts --config.package-manager-strict=false",
      "appflare-pack /workspace/appflare-build/source --manifest /workspace/appflare-build/appflare.json --out /workspace/appflare-build/out --no-install",
      "cd /workspace/appflare-build/out && stat -c '%s %n' -- *",
      "<mount BUILDS /builds/01J8INSTALL/1.2.3 at /mnt/appflare-builds>",
      "cp -- /workspace/appflare-build/out/manifest.json /workspace/appflare-build/out/widget-1.2.3.zip /mnt/appflare-builds/ && sync",
      "<unmount /mnt/appflare-builds>",
    ]);
    // Every command runs in the fixed, credential-free environment.
    for (const used of sandbox.envs) expect(used).toEqual(BUILD_ENV);
    // The packer gets the catalog manifest verbatim.
    expect(JSON.parse(sandbox.written.get(MANIFEST_INPUT) ?? "null")).toEqual(
      withBuildCommand("pnpm build"),
    );

    // The stored files are the packed ones, and the log says it succeeded.
    const zip = await env.BUILDS.get(result.artifactKey);
    expect(new Uint8Array(await (zip as R2ObjectBody).arrayBuffer())).toEqual(ZIP);
    const progress = await readProgress(env.BUILDS, result.logKey as string);
    expect(progress).toMatchObject({ state: "succeeded", stage: "verify" });
    expect(progress?.log).toContain("installed");
    expect(result.log).toBe(progress?.log);
  });

  it("never runs a build command itself: the packer runs the manifest's", async () => {
    const sandbox = fake();
    const input = request({ catalogManifest: withBuildCommand("pnpm build") });
    asResult(await build(sandbox, input).promise);
    expect(sandbox.commands.some((c) => c.includes("pnpm build"))).toBe(false);
  });

  it("refuses a request build command the manifest does not declare", async () => {
    const { promise, opened } = build(fake(), request({ buildCommand: ["pnpm", "build"] }));
    const failure = asFailure(await promise);
    expect(failure.stage).toBe("request");
    expect(failure.message).toContain("declares no install.buildCommand");
    expect(opened).toEqual([]);
  });

  it("reports a failing build command as the build step", async () => {
    const sandbox = fake({
      failures: [
        {
          match: /^appflare-pack /,
          exitCode: 1,
          output:
            "- running install.buildCommand: pnpm build (scrubbed environment)\n" +
            'appflare-pack: install.buildCommand "pnpm build" exited with code 1:\nvite: not found\n',
        },
      ],
    });
    const input = request({ catalogManifest: withBuildCommand("pnpm build") });
    const failure = asFailure(await build(sandbox, input).promise);
    expect(failure).toMatchObject({ stage: "build", exitCode: 1, retryable: false });
    expect(failure.message).toContain("the build command `pnpm build` failed (exit code 1)");
    expect(failure.message).toContain("vite: not found");
  });

  it("reports other packer failures as the pack step", async () => {
    const sandbox = fake({
      failures: [{ match: /^appflare-pack /, exitCode: 1, output: "appflare-pack: no main\n" }],
    });
    const failure = asFailure(await build(sandbox).promise);
    expect(failure).toMatchObject({ stage: "pack", exitCode: 1 });
  });

  it("lets the packer install the directories an entry lists, instead of the root install", async () => {
    const sandbox = fake();
    const installDirs = [{ path: "templates/blog", lockfile: "none" }, { path: "." }];
    const manifest = { ...catalogManifest, install: { ...catalogManifest.install, installDirs } };
    const result = asResult(await build(sandbox, request({ catalogManifest: manifest })).promise);
    expect(sandbox.commands.some((c) => c.startsWith("pnpm install"))).toBe(false);
    const pack =
      "appflare-pack /workspace/appflare-build/source --manifest /workspace/appflare-build/appflare.json --out /workspace/appflare-build/out";
    expect(sandbox.commands).toContain(pack);
    // The pack step gets the install step's time as well.
    expect(sandbox.timeouts.get(pack)).toBe(STAGE_TIMEOUTS.install + STAGE_TIMEOUTS.pack);
    expect(JSON.parse(sandbox.written.get(MANIFEST_INPUT) ?? "null").install.installDirs).toEqual(
      installDirs,
    );
    const progress = await readProgress(env.BUILDS, result.logKey as string);
    expect(progress?.log).toContain(
      "appflare-pack installs templates/blog, . in that order, install scripts disabled",
    );
  });

  it("installs nothing for an entry whose install directories are an empty list", async () => {
    const sandbox = fake();
    const manifest = {
      ...catalogManifest,
      install: { ...catalogManifest.install, installDirs: [] },
    };
    const result = asResult(await build(sandbox, request({ catalogManifest: manifest })).promise);
    expect(sandbox.commands.some((c) => c.startsWith("pnpm install"))).toBe(false);
    // The packer runs its own (empty) install rather than being told to skip one.
    expect(sandbox.commands).toContain(
      "appflare-pack /workspace/appflare-build/source --manifest /workspace/appflare-build/appflare.json --out /workspace/appflare-build/out",
    );
    const progress = await readProgress(env.BUILDS, result.logKey as string);
    expect(progress?.log).toContain(
      "The entry installs nothing (install.installDirs is empty): the build runs with no dependencies installed.",
    );
  });

  it("hands the packer an entry's D1 seed statements and seed-only values as declared", async () => {
    const sandbox = fake();
    const manifest = {
      ...catalogManifest,
      secrets: [
        { name: "ADMIN_PASSWORD", label: "Admin password", generate: true, seedOnly: true },
      ],
      resources: {
        d1: {
          DB: {
            seed: {
              hashes: { admin: { from: "ADMIN_PASSWORD", method: "bcrypt" } },
              statements: [
                {
                  sql: "INSERT OR IGNORE INTO admins (name, hash) VALUES ('admin', ?)",
                  params: [{ hash: "admin" }],
                },
              ],
            },
          },
        },
      },
    };
    asResult(await build(sandbox, request({ catalogManifest: manifest })).promise);
    const written = JSON.parse(sandbox.written.get(MANIFEST_INPUT) ?? "null");
    expect(written.resources).toEqual(manifest.resources);
    expect(written.secrets[0].seedOnly).toBe(true);
  });

  it("reports a failed install in the packer as the install step", async () => {
    const sandbox = fake({
      failures: [
        {
          match: /^appflare-pack /,
          exitCode: 1,
          output:
            "appflare-pack: installing dependencies in site failed: pnpm install --no-frozen-lockfile exited with 1:\nERR_PNPM_FETCH_404\n",
        },
      ],
    });
    const manifest = {
      ...catalogManifest,
      install: { ...catalogManifest.install, installDirs: [{ path: "site", lockfile: "none" }] },
    };
    const failure = asFailure(await build(sandbox, request({ catalogManifest: manifest })).promise);
    expect(failure).toMatchObject({ stage: "install", exitCode: 1, retryable: false });
    expect(failure.message).toContain("installing the dependencies failed");
    expect(failure.message).toContain("ERR_PNPM_FETCH_404");
  });

  it("refuses an install directory outside the checkout without starting a container", async () => {
    const manifest = {
      ...catalogManifest,
      install: { ...catalogManifest.install, installDirs: [{ path: "../elsewhere" }] },
    };
    const { promise, opened } = build(fake(), request({ catalogManifest: manifest }));
    const failure = asFailure(await promise);
    expect(failure.stage).toBe("request");
    expect(opened).toEqual([]);
  });

  it("refuses a stored zip whose files do not match manifest.json", async () => {
    const tampered = ZIP.slice();
    tampered[6] = 0xff;
    const sandbox = fake({
      packOutput: { "widget-1.2.3.zip": tampered, "manifest.json": packedManifest() },
    });
    const failure = asFailure(await build(sandbox).promise);
    expect(failure).toMatchObject({ stage: "verify", retryable: false });
    expect(failure.message).toContain("worker/index.js: sha256 does not match manifest.json");
  });

  it("checks the D1 schema files, post-deploy migrations and baseline of the stored zip too", async () => {
    const d1File = (dir: string, name: string) => ({
      name,
      path: `${dir}/DB/${name}`,
      offset: 10,
      size: 2,
      sha256: "0".repeat(64),
    });
    for (const [field, dir, layout] of [
      ["d1Schema", "d1-schema", { schema: ["schema.sql"] }],
      ["d1PostDeploy", "d1-post-deploy", { postDeployMigrationsDir: "after" }],
      ["d1Baseline", "d1-baseline", { baseline: "schema.sql" }],
    ] as const) {
      const name = field === "d1PostDeploy" ? "0001_after.sql" : "schema.sql";
      const manifest = packedManifest({
        format: field === "d1Baseline" ? 5 : 3,
        [field]: { DB: [d1File(dir, name)] },
        catalog: { ...catalogManifest, resources: { d1: { DB: layout } } },
      });
      const sandbox = fake({ packOutput: { "widget-1.2.3.zip": ZIP, "manifest.json": manifest } });
      const failure = asFailure(await build(sandbox).promise);
      expect(failure).toMatchObject({ stage: "verify", retryable: false });
      expect(failure.message).toContain(`${dir}/DB/${name}: sha256 does not match manifest.json`);
    }
  });

  it("fetches the pinned commit when the ref has moved", async () => {
    const sandbox = fake({ refHead: OTHER_SHA });
    asResult(await build(sandbox).promise);
    expect(sandbox.commands).toContain(
      "git -C /workspace/appflare-build/source fetch -q --depth 1 origin " +
        `${SHA} && git -C /workspace/appflare-build/source checkout -q --detach FETCH_HEAD`,
    );
  });

  it("fetches the pinned commit into a fresh repository when the ref cannot be cloned", async () => {
    const sandbox = fake({ cloneFails: true });
    asResult(await build(sandbox).promise);
    expect(sandbox.commands).toContain(
      "rm -rf /workspace/appflare-build/source && git init -q /workspace/appflare-build/source && " +
        "git -C /workspace/appflare-build/source remote add origin https://github.com/acme/widget.git && " +
        `git -C /workspace/appflare-build/source fetch -q --depth 1 origin ${SHA} && ` +
        "git -C /workspace/appflare-build/source checkout -q --detach FETCH_HEAD",
    );
  });

  it("fails the checkout when HEAD is still not the pin", async () => {
    const sandbox = fake({ refHead: OTHER_SHA, fetchHead: OTHER_SHA });
    const failure = asFailure(await build(sandbox).promise);
    expect(failure).toMatchObject({ stage: "checkout", retryable: false, exitCode: null });
    expect(failure.message).toContain(`not the pinned ${SHA}`);
    expect(sandbox.destroyed).toBe(true);
  });

  it("names the failing step, quotes its output, and marks exits as not retryable", async () => {
    const sandbox = fake({
      failures: [{ match: /^pnpm install/, exitCode: 1, output: "ERR_PNPM_OUTDATED_LOCKFILE\n" }],
    });
    const failure = asFailure(await build(sandbox).promise);
    expect(failure).toMatchObject({ stage: "install", exitCode: 1, retryable: false });
    expect(failure.message).toContain("installing the dependencies failed (exit code 1)");
    expect(failure.message).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
    expect(sandbox.commands.some((c) => c.startsWith("appflare-pack"))).toBe(false);
    expect(sandbox.destroyed).toBe(true);
    const progress = await readProgress(env.BUILDS, failure.logKey as string);
    expect(progress).toMatchObject({ state: "failed", stage: "install" });
  });

  it("marks a container that cannot run commands as retryable", async () => {
    const sandbox = fake({
      failures: [{ match: /^rm -rf/, throws: "Container is not ready (capacity)" }],
    });
    const failure = asFailure(await build(sandbox).promise);
    expect(failure).toMatchObject({ stage: "checkout", retryable: true, exitCode: null });
    expect(failure.message).toContain("capacity");
  });

  it("builds in a fresh container when a new version of the Worker resets the first as it starts", async () => {
    const first = fake({
      failures: [
        {
          match: /^rm -rf/,
          throws:
            "Sandbox operation sandbox.exec was interrupted while the platform was updating the sandbox runtime",
        },
      ],
      destroyThrows: "Durable Object reset because its code was updated",
    });
    const fresh = fake();
    const { promise, opened } = build([first, fresh]);
    const result = asResult(await promise);
    const id = await sandboxId("01J8INSTALL", SHA);
    expect(opened.map((o) => o.id)).toEqual([id, `${id}-r`]);
    expect(first.commands).toHaveLength(1);
    expect(fresh.commands.some((c) => c.startsWith("appflare-pack"))).toBe(true);
    expect(fresh.destroyed).toBe(true);
    expect(result.log).toContain("starting again in a fresh container");
    expect(result.log).not.toContain("FAILED");
  });

  it("refuses a pack that produced another version", async () => {
    const sandbox = fake({
      packOutput: { "widget-1.2.4.zip": ZIP, "manifest.json": packedManifest() },
    });
    const failure = asFailure(await build(sandbox).promise);
    expect(failure.stage).toBe("pack");
    expect(failure.message).toContain("expected manifest.json, widget-1.2.3.zip");
  });

  it("refuses a packed manifest that does not describe the build", async () => {
    const sandbox = fake({
      packOutput: {
        "widget-1.2.3.zip": ZIP,
        "manifest.json": packedManifest({ keyId: "catalog-2026-09" }),
      },
    });
    const failure = asFailure(await build(sandbox).promise);
    expect(failure).toMatchObject({ stage: "verify", retryable: false });
    expect(failure.message).toContain("keyId is catalog-2026-09");
  });

  it("refuses an invalid request without starting a container", async () => {
    const sandbox = fake();
    const { promise, opened } = build(sandbox, request({ sha: OTHER_SHA }));
    const failure = asFailure(await promise);
    expect(failure).toMatchObject({ stage: "request", logKey: null, retryable: false });
    expect(opened).toEqual([]);
  });

  it("runs on the large container class when the entry asks for it", async () => {
    const { promise, opened } = build(fake(), request({ instanceType: "standard-2" }));
    asResult(await promise);
    expect(opened[0]?.instanceType).toBe("standard-2");
  });

  it("replaces what an earlier build of the same version left", async () => {
    await env.BUILDS.put("builds/01J8INSTALL/1.2.3/stale.zip", "old");
    asResult(await build(fake()).promise);
    expect(await env.BUILDS.head("builds/01J8INSTALL/1.2.3/stale.zip")).toBeNull();
  });
});

describe("cleanup and progress", () => {
  it("deletes an install's builds except the kept versions", async () => {
    for (const key of [
      "builds/i1/1.0.0/manifest.json",
      "builds/i1/1.1.0/manifest.json",
      "builds/i1/1.2.0/log.txt",
      "builds/i2/1.0.0/manifest.json",
    ]) {
      await env.BUILDS.put(key, "x");
    }
    expect(await deleteInstallBuilds(env.BUILDS, "i1", ["1.1.0"])).toBe(2);
    const left = (await env.BUILDS.list()).objects.map((o) => o.key).sort();
    expect(left).toEqual(["builds/i1/1.1.0/manifest.json", "builds/i2/1.0.0/manifest.json"]);
  });

  it("is served over RPC by the SandboxBuilds entrypoint", async () => {
    asResult(await build(fake()).promise);
    const builds = exports.default;
    const progress = await builds.progress({ installId: "01J8INSTALL", version: "1.2.3" });
    expect(progress?.state).toBe("succeeded");
    expect(await builds.progress({ installId: "01J8INSTALL", version: "9.9.9" })).toBeNull();
    expect(await builds.info()).toEqual({
      protocol: SANDBOX_PROTOCOL_VERSION,
      sandboxVersion: "0.1.0",
      image: "docker.io/mendylanda/appflare-sandbox:0.1.0",
      features: [
        SANDBOX_FEATURE_SELF_DEPLOYING,
        SANDBOX_FEATURE_REPOSITORY,
        SANDBOX_FEATURE_GITHUB_TOKENS,
        SANDBOX_FEATURE_INSTALL_DIRS,
        SANDBOX_FEATURE_CONFIG_PATCH,
        SANDBOX_FEATURE_D1_SEED,
        SANDBOX_FEATURE_D1_BASELINE,
        SANDBOX_FEATURE_WRANGLER_CONFIG_INLINE,
        SANDBOX_FEATURE_ASSETS_ONLY,
      ],
      // The version metadata binding's id (vitest.config.ts).
      versionId: "version-under-test",
    });
    expect(await builds.cleanup({ installId: "01J8INSTALL", keepVersions: [] })).toEqual({
      deleted: 3,
    });
  });
});

describe("sandboxId", () => {
  it("stays within the SDK's limit for the longest install ids, and keeps them apart", async () => {
    const long = "A".repeat(64);
    const alsoLong = `${"A".repeat(63)}B`;
    const id = await sandboxId(long, SHA);
    expect(id.length).toBeLessThanOrEqual(MAX_SANDBOX_ID_LENGTH);
    expect(id).toMatch(/^build-a{24}-[0-9a-f]{10}-0123456$/);
    expect(await sandboxId(alsoLong, SHA)).not.toBe(id);
    expect(await sandboxId("01J8INSTALL", SHA)).toMatch(/^build-01j8install-[0-9a-f]{10}-0123456$/);
    // A later attempt of the caller's gets a container of its own.
    expect(await sandboxId("01J8INSTALL", SHA, 2)).toMatch(
      /^build-01j8install-[0-9a-f]{10}-0123456-a2$/,
    );
    expect((await sandboxId(long, SHA, 20)).length).toBeLessThanOrEqual(MAX_SANDBOX_ID_LENGTH);
    // So does the fresh container a run starts over in.
    expect(freshSandboxId(await sandboxId(long, SHA, 20)).length).toBeLessThanOrEqual(
      MAX_SANDBOX_ID_LENGTH,
    );
  });
});
