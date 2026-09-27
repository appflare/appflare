import { reset } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { createHash } from "node:crypto";
import {
  type BuildFailure,
  type RepositoryBuildResult,
  repositoryBuildOutcomeSchema,
  SANDBOX_FEATURE_REPOSITORY,
  SANDBOX_PROTOCOL_VERSION,
} from "@appflare/schema";
import { afterEach, describe, expect, it } from "vitest";
import { readProgress } from "./log";
import { BUILD_ENV, MANIFEST_INPUT, repositorySandboxId } from "./protocol";
import { runRepositoryBuild } from "./repository";
import { type FakeFailure, FakeSandbox, type FakeSandboxOptions } from "./test/fake-sandbox";

// The container cannot run in tests: every build here runs against
// FakeSandbox, which plays a fake git host (`refs`) and a fixture repository
// (`files`), with Miniflare's local R2 as the BUILDS bucket.

const MAIN = "0123456789abcdef0123456789abcdef01234567";
const TAGGED = "fedcba9876543210fedcba9876543210fedcba98";
const INSTALL = "01J8REPOINSTALL";
const RUN = "src-01J8REPOJOB";

/** The fixture: a Worker with a KV binding, a pnpm lockfile, a build script and one secret. */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "cut",
    description: "Self-hosted link shortener.",
    license: "MIT",
    scripts: { build: "pnpm build:css" },
  }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "wrangler.jsonc": `{
    // Cut on Workers
    "name": "cut",
    "main": "src/worker.ts",
    "kv_namespaces": [{ "binding": "CUT_KV" }],
    "vars": { "HOME_PAGE": "default" },
  }`,
  ".dev.vars.example": "# Password required to add links.\nADMIN_PASSWORD=\nHOME_PAGE=\n",
  src: "",
};

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);

const MODULE = {
  name: "index.js",
  type: "esm",
  path: "worker/index.js",
  offset: 4,
  size: 6,
  sha256: createHash("sha256").update(ZIP.subarray(4, 10)).digest("hex"),
};

/** What the packer writes for the catalog manifest the build handed it. */
function packFor(catalog: unknown): Record<string, Uint8Array> {
  const c = catalog as {
    slug: string;
    repo: string;
    source: { ref: string; sha: string };
    install: { version: string };
  };
  const manifest = {
    format: 1,
    app: c.slug,
    version: c.install.version,
    source: { repo: c.repo, sha: c.source.sha, ref: c.source.ref },
    builtAt: "2026-09-25T12:00:00.000Z",
    builder: "@appflare/pack@0.2.0",
    keyId: "unsigned",
    worker: {
      name: c.slug,
      mainModule: "index.js",
      compatibilityDate: "2026-09-01",
      compatibilityFlags: [],
      modules: [MODULE],
      bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
      migrations: [],
      crons: [],
      observability: null,
      placement: null,
      limits: null,
    },
    assets: { config: {}, binding: null, files: [] },
    d1Migrations: {},
    catalog,
  };
  return {
    [`${c.slug}-${c.install.version}.zip`]: ZIP,
    "manifest.json": new TextEncoder().encode(`${JSON.stringify(manifest)}\n`),
  };
}

function fake(options: Partial<FakeSandboxOptions> & { failures?: FakeFailure[] } = {}) {
  return new FakeSandbox({
    bucket: env.BUILDS,
    refHead: MAIN,
    refs: { main: MAIN, "v1.4.0": TAGGED },
    defaultBranch: "main",
    committedAt: "2026-09-20T10:00:00+00:00",
    files: FILES,
    inspect: { name: "cut", vars: ["HOME_PAGE"], unsupported: [] },
    packOutput: packFor,
    ...options,
  });
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: INSTALL,
    runId: RUN,
    repo: "MendyLanda/cut",
    ...overrides,
  };
}

function build(
  sandbox: FakeSandbox,
  input: Record<string, unknown> = request(),
  githubToken?: (secretName: string) => string | null,
) {
  const opened: string[] = [];
  let clock = Date.parse("2026-09-25T12:00:00Z");
  const promise = runRepositoryBuild(input, {
    ...(githubToken === undefined ? {} : { githubToken }),
    bucket: env.BUILDS,
    sandboxVersion: "0.2.0",
    openSandbox: (id) => {
      opened.push(id);
      return sandbox;
    },
    now: () => {
      clock += 3_000;
      return clock;
    },
    flushIntervalMs: 60_000,
  });
  return { promise, opened };
}

function asResult(outcome: unknown): RepositoryBuildResult {
  const parsed = repositoryBuildOutcomeSchema.parse(outcome);
  if (!parsed.ok) throw new Error(`expected a result, got ${parsed.stage}: ${parsed.message}`);
  return parsed;
}

function asFailure(outcome: unknown): BuildFailure {
  const parsed = repositoryBuildOutcomeSchema.parse(outcome);
  if (parsed.ok) throw new Error("expected a failure");
  return parsed;
}

function packedCatalog(sandbox: FakeSandbox): Record<string, unknown> {
  return JSON.parse(sandbox.written.get(MANIFEST_INPUT) ?? "null") as Record<string, unknown>;
}

afterEach(() => reset());

describe("runRepositoryBuild", () => {
  it("clones the default branch, works out the manifest, and stores the artifact", async () => {
    const sandbox = fake();
    const { promise, opened } = build(sandbox);
    const result = asResult(await promise);

    expect(opened).toEqual([await repositorySandboxId(INSTALL)]);
    expect(result).toMatchObject({
      installId: INSTALL,
      version: "0.0.0-20260920.0123456",
      commit: MAIN,
      ref: "main",
      committedAt: "2026-09-20T10:00:00+00:00",
      manifestKey: "builds/01J8REPOINSTALL/0.0.0-20260920.0123456/manifest.json",
      artifactKey: "builds/01J8REPOINSTALL/0.0.0-20260920.0123456/cut-0.0.0-20260920.0123456.zip",
      logKey: `builds/${INSTALL}/${RUN}/log.txt`,
      image: "docker.io/mendylanda/appflare-sandbox:0.2.0",
      detected: {
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        buildCommand: "pnpm run build",
        buildCommandFrom: "package.json",
        secretsFrom: ".dev.vars.example",
        unsupported: [],
      },
    });
    expect(sandbox.destroyed).toBe(true);
    expect(sandbox.commands.slice(0, 4)).toEqual([
      "rm -rf /workspace/appflare-build && mkdir -p /workspace/appflare-build",
      "<gitCheckout https://github.com/MendyLanda/cut.git (default branch)>",
      "git -C /workspace/appflare-build/source rev-parse HEAD",
      "git -C /workspace/appflare-build/source rev-parse --abbrev-ref HEAD",
    ]);
    expect(sandbox.commands).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts --config.package-manager-strict=false",
    );
    // The build command goes to the packer through the manifest; never run on its own.
    expect(sandbox.commands.some((c) => c === "pnpm run build")).toBe(false);
    for (const used of sandbox.envs) expect(used).toEqual(BUILD_ENV);

    const catalog = packedCatalog(sandbox);
    expect(catalog).toMatchObject({
      slug: "cut",
      name: "MendyLanda/cut",
      repo: "MendyLanda/cut",
      summary: "Self-hosted link shortener.",
      source: { ref: "main", sha: MAIN },
      install: { tier: "sandbox", buildCommand: "pnpm run build", workerName: "cut" },
      secrets: [{ name: "ADMIN_PASSWORD", help: "Password required to add links." }],
      vars: [{ name: "HOME_PAGE" }],
    });
    const progress = await readProgress(env.BUILDS, result.logKey as string);
    expect(progress).toMatchObject({ state: "succeeded", stage: "verify" });
    expect(progress?.log).toContain("Build command: pnpm run build (package.json).");
  });

  it("builds a tag and names the version after it", async () => {
    const sandbox = fake();
    const result = asResult(await build(sandbox, request({ ref: "v1.4.0" })).promise);
    expect(result).toMatchObject({ commit: TAGGED, ref: "v1.4.0", version: "1.4.0" });
    expect(sandbox.commands).toContain(
      "<gitCheckout https://github.com/MendyLanda/cut.git v1.4.0>",
    );
  });

  it("fetches the commit the caller resolved when the branch moved on since", async () => {
    const sandbox = fake({ refs: { main: TAGGED }, commits: [MAIN, TAGGED] });
    const result = asResult(await build(sandbox, request({ ref: "main", commit: MAIN })).promise);
    expect(result).toMatchObject({ commit: MAIN, ref: "main" });
    expect(sandbox.commands).toContain(
      `git -C /workspace/appflare-build/source fetch -q --depth 1 origin ${MAIN} && git -C /workspace/appflare-build/source checkout -q --detach FETCH_HEAD`,
    );
  });

  it("checks out a commit given as the ref without cloning a branch", async () => {
    const sandbox = fake();
    const result = asResult(await build(sandbox, request({ ref: TAGGED })).promise);
    expect(result).toMatchObject({ commit: TAGGED, ref: TAGGED });
    expect(sandbox.commands.some((c) => c.startsWith("<gitCheckout"))).toBe(false);
  });

  it("refuses a branch the repository does not have, without retrying", async () => {
    const failure = asFailure(await build(fake(), request({ ref: "nope" })).promise);
    expect(failure).toMatchObject({ stage: "checkout", retryable: false });
    expect(failure.message).toContain("could not be cloned at nope");
  });

  it("refuses a project without a lockfile in the detect step", async () => {
    const files = { ...FILES };
    delete files["pnpm-lock.yaml"];
    const failure = asFailure(await build(fake({ files })).promise);
    expect(failure).toMatchObject({ stage: "detect", retryable: false });
    expect(failure.message).toContain("has no lockfile");
  });

  it("refuses a repository that is not a Workers project", async () => {
    const files = { ...FILES };
    delete files["wrangler.jsonc"];
    const failure = asFailure(await build(fake({ files })).promise);
    expect(failure).toMatchObject({ stage: "detect" });
    expect(failure.message).toContain("no wrangler.json, wrangler.jsonc or wrangler.toml");
  });

  it("reports the wrangler config sections the packer does not carry, as wrangler reads them", async () => {
    // A TOML config: wrangler reads it (appflare-pack inspect), not the sandbox Worker.
    const files: Record<string, string> = {
      ...FILES,
      "wrangler.toml": '[[containers]]\nclass_name = "Box"\n',
    };
    delete files["wrangler.jsonc"];
    const sandbox = fake({
      files,
      inspect: { name: "boxes", vars: [], unsupported: ["containers"] },
    });
    const result = asResult(await build(sandbox).promise);
    expect(result.detected).toMatchObject({
      wranglerConfig: "wrangler.toml",
      unsupported: ["containers"],
    });
    expect(sandbox.commands).toContain(
      "appflare-pack inspect /workspace/appflare-build/source --config wrangler.toml",
    );
    expect(packedCatalog(sandbox)).toMatchObject({ install: { workerName: "boxes" } });
  });

  it("stops in the detect step when wrangler cannot read the config", async () => {
    const failure = asFailure(
      await build(
        fake({ failures: [{ match: /^appflare-pack inspect /, output: "✘ Invalid TOML\n" }] }),
      ).promise,
    );
    expect(failure).toMatchObject({ stage: "detect", retryable: false });
    expect(failure.message).toContain("wrangler could not read wrangler.jsonc");
  });

  it("runs the admin's build command, or none", async () => {
    const entered = fake();
    const withCommand = asResult(
      await build(
        entered,
        request({ buildCommand: { mode: "command", command: "pnpm build:css" } }),
      ).promise,
    );
    expect(withCommand.detected).toMatchObject({
      buildCommand: "pnpm build:css",
      buildCommandFrom: "entered",
    });
    const none = fake();
    const without = asResult(
      await build(none, request({ buildCommand: { mode: "none" } })).promise,
    );
    expect(without.detected).toMatchObject({ buildCommand: null, buildCommandFrom: "none" });
    expect(packedCatalog(none).install).not.toHaveProperty("buildCommand");
  });

  it("refuses shell syntax in the admin's build command before any container starts", async () => {
    const { promise, opened } = build(
      fake(),
      request({ buildCommand: { mode: "command", command: "pnpm build && curl x" } }),
    );
    const failure = asFailure(await promise);
    expect(failure.stage).toBe("request");
    expect(opened).toEqual([]);
  });

  it("builds a catalog app from source with the catalog's manifest", async () => {
    const baseline = {
      slug: "cut",
      name: "Cut",
      summary: "Link shortener.",
      homepage: "https://github.com/MendyLanda/cut",
      repo: "MendyLanda/cut",
      license: "MIT",
      categories: ["utilities"],
      maintainers: ["MendyLanda"],
      source: { ref: "v0.1.0", sha: "f".repeat(40) },
      install: {
        tier: "artifact",
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        workerName: "cut",
        version: "0.1.0",
      },
      plan: "free",
      requires: [],
      secrets: [{ name: "ADMIN_PASSWORD", label: "Admin password", generate: true }],
      vars: [],
      postInstall: [],
      tokenPermissions: [],
    };
    const sandbox = fake();
    const result = asResult(await build(sandbox, request({ ref: "main", baseline })).promise);
    expect(result.detected).toMatchObject({
      buildCommand: "pnpm run build",
      buildCommandFrom: "package.json",
      secretsFrom: "catalog",
    });
    expect(packedCatalog(sandbox)).toMatchObject({
      name: "Cut",
      plan: "free",
      source: { ref: "main", sha: MAIN },
      install: { tier: "sandbox", version: "0.0.0-20260920.0123456" },
      secrets: [{ name: "ADMIN_PASSWORD", generate: true }],
    });
  });

  it("lets the packer install a catalog app's listed directories, even without a root package.json", async () => {
    const baseline = {
      slug: "blog",
      name: "Blog",
      summary: "A blog template.",
      homepage: "https://github.com/MendyLanda/cut",
      repo: "MendyLanda/cut",
      license: "MIT",
      categories: [],
      maintainers: [],
      source: { ref: "main", sha: "f".repeat(40) },
      install: {
        tier: "artifact",
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        workerName: "blog",
        installDirs: [{ path: "templates/blog", lockfile: "none" }],
      },
      plan: "free",
      requires: [],
      secrets: [],
      vars: [],
      postInstall: [],
      tokenPermissions: [],
    };
    const sandbox = fake({ files: { "wrangler.jsonc": FILES["wrangler.jsonc"] ?? "" } });
    const result = asResult(await build(sandbox, request({ ref: "main", baseline })).promise);
    expect(result.detected).toMatchObject({
      installDirs: [{ path: "templates/blog", lockfile: "none" }],
    });
    expect(sandbox.commands.some((c) => c.startsWith("pnpm install"))).toBe(false);
    expect(
      sandbox.commands.some((c) => c.startsWith("appflare-pack ") && !c.includes("--no-install")),
    ).toBe(true);
    expect(packedCatalog(sandbox)).toMatchObject({
      install: { installDirs: [{ path: "templates/blog", lockfile: "none" }] },
    });
    expect(result.log).toContain(
      "Install directories: templates/blog (no lockfile upstream) (from the catalog).",
    );
  });

  it("gives a rebuild a version of its own when the install already has that one", async () => {
    const result = asResult(
      await build(fake(), request({ avoidVersions: ["0.0.0-20260920.0123456"] })).promise,
    );
    expect(result.version).toBe("0.0.0-20260920.0123456+0123456");
  });
});

describe("runRepositoryBuild of a private repository", () => {
  const SECRET = "GITHUB_TOKEN_01J8TOKEN00000";
  const TOKEN = "github_pat_11AAAAAAA0secretvalue_DO_NOT_LEAK";
  const BASIC = btoa(`x-access-token:${TOKEN}`);
  const held = (name: string) => (name === SECRET ? TOKEN : null);
  const SRC = "/workspace/appflare-build/source";

  it("fetches the resolved commit with the token as the password, only in git's environment", async () => {
    const sandbox = fake();
    const { promise } = build(
      sandbox,
      request({ ref: "main", commit: MAIN, tokenSecret: SECRET }),
      held,
    );
    const result = asResult(await promise);
    expect(result).toMatchObject({ commit: MAIN, ref: "main" });

    // No SDK clone (it takes no environment); a plain remote URL, then a fetch.
    expect(sandbox.commands.some((c) => c.startsWith("<gitCheckout"))).toBe(false);
    expect(sandbox.commands).toContain(
      `rm -rf ${SRC} && git init -q ${SRC} && git -C ${SRC} remote add origin https://github.com/MendyLanda/cut.git && git -C ${SRC} fetch -q --depth 1 origin ${MAIN} && git -C ${SRC} checkout -q --detach FETCH_HEAD`,
    );
    for (const command of sandbox.commands) {
      expect(command).not.toContain(TOKEN);
      expect(command).not.toContain(BASIC);
    }

    // Exactly one command gets the token: the fetch. The install and the
    // packer, which run the repository's code, get the plain build environment.
    const withToken = sandbox.envs.filter((e) => "GIT_CONFIG_VALUE_0" in e);
    expect(withToken).toEqual([
      {
        ...BUILD_ENV,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${BASIC}`,
      },
    ]);
    for (const used of sandbox.envs.filter((e) => !("GIT_CONFIG_VALUE_0" in e))) {
      expect(used).toEqual(BUILD_ENV);
    }

    const stored = await readProgress(env.BUILDS, `builds/${INSTALL}/${RUN}/log.txt`);
    expect(stored?.log).toContain("read with a GitHub access token");
    for (const text of [JSON.stringify(result), stored?.log ?? ""]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(BASIC);
    }
  });

  it("fetches the ref by name when no commit was resolved", async () => {
    const sandbox = fake();
    const result = asResult(
      await build(sandbox, request({ ref: "v1.4.0", tokenSecret: SECRET }), held).promise,
    );
    expect(result).toMatchObject({ commit: TAGGED, ref: "v1.4.0" });
    expect(sandbox.commands.some((c) => c.includes("fetch -q --depth 1 origin v1.4.0"))).toBe(true);
  });

  it("names the token in a failed fetch and keeps its value out of the message", async () => {
    const sandbox = fake({
      failures: [
        {
          match: /fetch -q --depth 1/,
          exitCode: 128,
          output: `fatal: Authentication failed for 'https://x-access-token:${TOKEN}@github.com/MendyLanda/cut.git/'\n`,
        },
      ],
    });
    const failure = asFailure(
      await build(sandbox, request({ ref: "main", commit: MAIN, tokenSecret: SECRET }), held)
        .promise,
    );
    expect(failure).toMatchObject({ stage: "checkout", retryable: false });
    expect(failure.message).toContain("with the GitHub access token");
    expect(JSON.stringify(failure)).not.toContain(TOKEN);
  });

  it("refuses a token this Worker does not hold before a container starts", async () => {
    const { promise, opened } = build(
      fake(),
      request({ ref: "main", commit: MAIN, tokenSecret: SECRET }),
      () => null,
    );
    const failure = asFailure(await promise);
    expect(failure).toMatchObject({ stage: "checkout", retryable: false });
    expect(failure.message).toContain(`does not hold the GitHub access token ${SECRET}`);
    expect(opened).toEqual([]);
  });

  it("takes only a GitHub access token secret's name, never another secret's", async () => {
    const failure = asFailure(
      await build(fake(), request({ tokenSecret: "APP_TOKEN_01J8INSTALL" }), () => TOKEN).promise,
    );
    expect(failure.stage).toBe("request");
  });
});

describe("SandboxBuilds entrypoint", () => {
  it("says it builds from repositories", async () => {
    const info = await exports.SandboxBuilds.info();
    expect(info.features).toContain(SANDBOX_FEATURE_REPOSITORY);
  });
});
