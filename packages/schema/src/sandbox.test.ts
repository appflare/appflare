import { describe, expect, it } from "vitest";
import {
  buildKeys,
  buildOutcomeSchema,
  buildRequestSchema,
  checkoutPathSchema,
  installBuildsPrefix,
  isBuildObjectKey,
  SANDBOX_PROTOCOL_VERSION,
  sandboxImage,
  sandboxObjectUrl,
} from "./index";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function request(
  overrides: Record<string, unknown> = {},
  declaredBuildCommand?: string,
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
