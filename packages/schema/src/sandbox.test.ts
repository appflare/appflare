import { describe, expect, it } from "vitest";
import {
  buildCommandArgvList,
  buildCommandRequestArgv,
  buildKeys,
  buildOutcomeSchema,
  buildRequestSchema,
  checkoutPathSchema,
  installBuildsPrefix,
  isBuildObjectKey,
  SANDBOX_PROTOCOL_VERSION,
  sandboxImage,
  sandboxObjectUrl,
  selfManagedRunRequestSchema,
  VOID_RUN_ENV,
} from "./index";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function request(
  overrides: Record<string, unknown> = {},
  declaredBuildCommand?: string | string[],
): Record<string, unknown> {
  return {
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: "01J8ZK0ABCDEF",
    version: "1.2.3",
    repo: "acme/widget",
    sha: SHA,
    wranglerConfigPath: "wrangler.jsonc",
    catalogManifest: {
      slug: "widget",
      name: "Widget",
      repo: "acme/widget",
      source: { ref: "v1.2.3", sha: SHA },
      install: {
        tier: "sandbox",
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        workerName: "widget",
        ...(declaredBuildCommand === undefined ? {} : { buildCommand: declaredBuildCommand }),
      },
      secrets: [],
    },
    ...overrides,
  };
}

describe("buildRequestSchema", () => {
  it("accepts a request and keeps the whole catalog manifest", () => {
    const parsed = buildRequestSchema.parse(
      request({ buildCommand: ["pnpm", "build"] }, "pnpm build"),
    );
    expect(parsed.catalogManifest).toMatchObject({ name: "Widget", secrets: [] });
    expect(parsed.buildCommand).toEqual(["pnpm", "build"]);
  });

  it("checks the catalog manifest's config patch and keeps it", () => {
    const withPatch = (configPatch: unknown) => {
      const r = request();
      const manifest = r.catalogManifest as { install: Record<string, unknown> };
      manifest.install.configPatch = configPatch;
      return buildRequestSchema.safeParse(r);
    };
    const accepted = withPatch({ build: null });
    expect(accepted.data?.catalogManifest.install).toMatchObject({ configPatch: { build: null } });
    expect(withPatch({ name: "other" }).error?.issues.map((i) => i.path.join("."))).toEqual([
      "catalogManifest.install.configPatch.name",
    ]);
  });

  it("refuses another protocol version", () => {
    expect(buildRequestSchema.safeParse(request({ protocol: 2 })).success).toBe(false);
  });

  it("requires repo, sha, and wrangler config to match the catalog manifest", () => {
    const issues = (r: Record<string, unknown>) =>
      buildRequestSchema.safeParse(r).error?.issues.map((i) => i.path.join("."));
    expect(issues(request({ repo: "acme/other" }))).toEqual(["repo"]);
    expect(issues(request({ sha: "f".repeat(40) }))).toEqual(["sha"]);
    expect(issues(request({ wranglerConfigPath: "other.jsonc" }))).toEqual(["wranglerConfigPath"]);
  });

  it("takes the build command from the catalog manifest only", () => {
    const issues = (r: Record<string, unknown>) =>
      buildRequestSchema.safeParse(r).error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    // The manifest alone: the packer runs it.
    expect(buildRequestSchema.safeParse(request({}, "pnpm build")).success).toBe(true);
    // A repeat of it, word for word.
    expect(
      buildRequestSchema.safeParse(request({ buildCommand: ["pnpm", "build"] }, "pnpm  build"))
        .success,
    ).toBe(true);
    // Another command, or one the manifest does not declare, is refused.
    expect(issues(request({ buildCommand: ["npm", "run", "build"] }, "pnpm build"))).toEqual([
      "buildCommand: differs from the catalog manifest's install.buildCommand",
    ]);
    expect(issues(request({ buildCommand: ["pnpm", "build"] }))?.[0]).toMatch(
      /^buildCommand: is set, but the catalog manifest declares no install\.buildCommand/,
    );
  });

  it("takes a list of build commands from the manifest, never repeated in the request", () => {
    const declared = ["pnpm run build:sphere", "pnpm run build"];
    expect(buildRequestSchema.safeParse(request({}, declared)).success).toBe(true);
    expect(
      buildRequestSchema.safeParse(request({ buildCommand: ["pnpm", "build"] }, ["pnpm build"]))
        .success,
    ).toBe(true);
    const refused = buildRequestSchema.safeParse(
      request({ buildCommand: ["pnpm", "run", "build"] }, declared),
    );
    expect(refused.error?.issues.map((i) => i.message)).toEqual([
      "is set, but the catalog manifest declares several build commands; leave it out, the packer runs them all",
    ]);
    expect(
      buildRequestSchema.safeParse(request({}, ["pnpm build", "pnpm build | tee"])).success,
    ).toBe(false);
  });

  it("carries one argv for a single command and a list of argvs for several", () => {
    expect(buildCommandRequestArgv("pnpm  --filter web build")).toEqual([
      "pnpm",
      "--filter",
      "web",
      "build",
    ]);
    expect(buildCommandRequestArgv(["pnpm build"])).toEqual(["pnpm", "build"]);
    const several = buildCommandRequestArgv(["pnpm run a", "pnpm run b"]);
    expect(several).toEqual([
      ["pnpm", "run", "a"],
      ["pnpm", "run", "b"],
    ]);
    expect(buildCommandArgvList(several)).toEqual(several);
    expect(buildCommandArgvList(["pnpm", "build"])).toEqual([["pnpm", "build"]]);
  });

  it("refuses shell syntax and environment assignments in either build command", () => {
    for (const argv of [["pnpm", "build;rm"], ["NODE_ENV=production", "vite"], ["a|b"], []]) {
      expect(
        buildRequestSchema.safeParse(request({ buildCommand: argv }, argv.join(" "))).success,
      ).toBe(false);
    }
    for (const declared of ["pnpm build | tee log", "NODE_ENV=production vite build"]) {
      expect(buildRequestSchema.safeParse(request({}, declared)).success).toBe(false);
    }
  });

  it("refuses entries of other tiers and unsafe ids, versions, and paths", () => {
    const artifactTier = request();
    (artifactTier.catalogManifest as { install: Record<string, unknown> }).install.tier =
      "artifact";
    expect(buildRequestSchema.safeParse(artifactTier).success).toBe(false);
    expect(buildRequestSchema.safeParse(request({ installId: "../x" })).success).toBe(false);
    expect(buildRequestSchema.safeParse(request({ version: "1.0/../x" })).success).toBe(false);
    expect(buildRequestSchema.safeParse(request({ subdirectory: "../up" })).success).toBe(false);
    expect(buildRequestSchema.safeParse(request({ instanceType: "basic" })).success).toBe(false);
  });
});

describe("checkoutPathSchema", () => {
  it("accepts nested and dot-prefixed paths, refuses traversal and absolute paths", () => {
    for (const ok of ["apps/web", ".output/server/wrangler.json", "wrangler.toml"]) {
      expect(checkoutPathSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["/etc", "a/../b", "./a", "a//b", "a b", "", "a\\b"]) {
      expect(checkoutPathSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("object keys", () => {
  it("names a build's objects under builds/<install>/<version>/", () => {
    expect(buildKeys("i1", "1.2.3", "widget")).toEqual({
      prefix: "builds/i1/1.2.3/",
      manifest: "builds/i1/1.2.3/manifest.json",
      artifact: "builds/i1/1.2.3/widget-1.2.3.zip",
      log: "builds/i1/1.2.3/log.txt",
    });
    expect(installBuildsPrefix("i1")).toBe("builds/i1/");
    expect(sandboxObjectUrl("builds/i1/1.2.3/manifest.json")).toBe(
      "https://sandbox/builds/i1/1.2.3/manifest.json",
    );
  });

  it("serves only safe keys under builds/", () => {
    expect(isBuildObjectKey("builds/i1/1.2.3/widget-1.2.3.zip")).toBe(true);
    for (const bad of [
      "other/x",
      "builds/",
      "builds/../secret",
      "builds/i1//x",
      "builds/i1/.hidden",
      "builds/i1/%2e%2e/x",
      "builds/i1/a b",
    ]) {
      expect(isBuildObjectKey(bad)).toBe(false);
    }
  });

  it("tags the image with the sandbox Worker version", () => {
    expect(sandboxImage("0.1.0")).toBe("docker.io/mendylanda/appflare-sandbox:0.1.0");
  });
});

describe("buildOutcomeSchema", () => {
  it("parses results and failures", () => {
    const base = { protocol: 1, sandboxVersion: "0.1.0", minutes: 1.5, logKey: "k", log: "" };
    expect(
      buildOutcomeSchema.parse({
        ok: true,
        ...base,
        image: sandboxImage("0.1.0"),
        installId: "i1",
        version: "1.2.3",
        digest: "a".repeat(64),
        size: 10,
        manifestKey: "m",
        artifactKey: "z",
      }).ok,
    ).toBe(true);
    expect(
      buildOutcomeSchema.parse({
        ok: false,
        ...base,
        logKey: null,
        stage: "request",
        message: "bad",
        retryable: false,
        exitCode: null,
      }).ok,
    ).toBe(false);
  });
});

describe("selfManagedRunRequestSchema", () => {
  const base = {
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: "01J8Z3Q4R5S6T7V8W9X0YZABCD",
    runId: "deploy-1.1.11",
    accountId: "0123456789abcdef0123456789abcdef",
    sha: SHA,
    packageManager: "pnpm",
    stage: "appflare-x0yzabcd",
    accountIdEnv: ["CLOUDFLARE_ACCOUNT_ID"],
    vars: {},
    secretNames: ["VOID_PLATFORM_RECOVERY_KEY"],
  };
  // In the order the request's fields have always come in.
  const alchemy = {
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: base.installId,
    runId: "deploy-0.1.9",
    accountId: base.accountId,
    tool: "alchemy",
    repo: "every-app/open-seo",
    sha: SHA,
    ref: "v0.1.9",
    packageManager: "pnpm",
    command: ["pnpm", "alchemy", "deploy", "--yes"],
    stage: base.stage,
    stageArg: "--stage",
    tokenEnv: ["CLOUDFLARE_API_TOKEN"],
    accountIdEnv: ["CLOUDFLARE_ACCOUNT_ID"],
    vars: {},
    secretNames: ["DATAFORSEO_API_KEY"],
    expectedWorkers: ["open-seo-appflare-x0yzabcd"],
  };
  const voidCommand = (...words: string[]) => ["pnpm", "exec", "void", "platform", ...words];
  const voidRun = {
    ...base,
    tool: "void",
    repo: "appflare/void-platform",
    ref: "main",
    commands: {
      discover: voidCommand(
        "discover",
        "--account",
        "{{accountId}}",
        "--installation",
        "{{stage}}",
      ),
      install: voidCommand("install", "--yes", "--name", "{{stage}}", "--workers-dev"),
      resume: voidCommand("install", "--resume", "--yes", "--name", "{{stage}}"),
      update: voidCommand("upgrade", "{{stage}}", "--yes"),
      destroy: voidCommand("uninstall", "{{stage}}", "--purge-resources", "--yes"),
    },
    tokenEnv: ["CLOUDFLARE_API_TOKEN", "VOID_PLATFORM_RUNTIME_CLOUDFLARE_API_TOKEN"],
    expectedWorkers: ["void-appflare-x0yzabcd-api"],
  };

  it("keeps an Alchemy request exactly as it was", () => {
    const parsed = selfManagedRunRequestSchema.parse(alchemy);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(alchemy));
    expect(selfManagedRunRequestSchema.safeParse({ ...alchemy, stageArg: undefined }).success).toBe(
      false,
    );
    // An Alchemy request has no command templates, and a Void one no single command.
    expect(selfManagedRunRequestSchema.safeParse({ ...voidRun, tool: "alchemy" }).success).toBe(
      false,
    );
    expect(selfManagedRunRequestSchema.safeParse({ ...alchemy, tool: "void" }).success).toBe(false);
  });

  it("round-trips a Void request with its command templates, stage and account", () => {
    const parsed = selfManagedRunRequestSchema.parse(structuredClone(voidRun));
    expect(parsed).toEqual(voidRun);
    if (parsed.tool !== "void") throw new Error("expected a void request");
    expect(parsed.commands.update).toEqual(voidCommand("upgrade", "{{stage}}", "--yes"));
    expect("stageArg" in parsed).toBe(false);
    // Every command must be there.
    const { resume: _resume, ...fewer } = voidRun.commands;
    expect(selfManagedRunRequestSchema.safeParse({ ...voidRun, commands: fewer }).success).toBe(
      false,
    );
  });

  it("refuses a Void command that does not name the installation", () => {
    const result = selfManagedRunRequestSchema.safeParse({
      ...voidRun,
      commands: { ...voidRun.commands, update: voidCommand("upgrade", "--yes") },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["commands", "update"]);
    for (const word of ["{{ stage }}", "{{name}}", "$(id)"]) {
      expect(
        selfManagedRunRequestSchema.safeParse({
          ...voidRun,
          commands: { ...voidRun.commands, install: voidCommand("install", "--name", word) },
        }).success,
      ).toBe(false);
    }
  });

  it("keeps what the sandbox Worker sets for a Void run out of the app's settings", () => {
    for (const name of VOID_RUN_ENV) {
      expect(
        selfManagedRunRequestSchema.safeParse({ ...voidRun, vars: { [name]: "x" } }).success,
      ).toBe(false);
      expect(
        selfManagedRunRequestSchema.safeParse({ ...voidRun, secretNames: [name] }).success,
      ).toBe(false);
    }
    // Nothing sets them for an Alchemy stack, which may use such a name.
    expect(
      selfManagedRunRequestSchema.safeParse({
        ...alchemy,
        vars: { VOID_PLATFORM_REGISTRY_DIR: "x" },
      }).success,
    ).toBe(true);
  });
});
