import { catalogManifestSchema } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  artifactVersion,
  chooseBuildCommand,
  DetectionError,
  detectPackageManager,
  detectWranglerConfig,
  labelOf,
  parseSecretsExample,
  readPackageFacts,
  repositoryManifest,
  repositorySlug,
  secretsNote,
  sourceBuildManifest,
  withRequiredSecrets,
  workerNameOf,
} from "./repository-manifest";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("detection", () => {
  it("names the package manager from the lockfile and refuses a project without one", () => {
    expect(detectPackageManager(new Set(["package.json", "pnpm-lock.yaml"]))).toBe("pnpm");
    expect(detectPackageManager(new Set(["package-lock.json"]))).toBe("npm");
    expect(detectPackageManager(new Set(["yarn.lock"]))).toBe("yarn");
    expect(detectPackageManager(new Set(["bun.lock"]))).toBe("bun");
    expect(() => detectPackageManager(new Set(["package.json"]))).toThrow(DetectionError);
  });

  it("finds the wrangler config wrangler's way and refuses a repository without one", () => {
    expect(detectWranglerConfig(new Set(["wrangler.toml", "wrangler.jsonc"]))).toBe(
      "wrangler.jsonc",
    );
    expect(detectWranglerConfig(new Set(["wrangler.json", "wrangler.jsonc"]))).toBe(
      "wrangler.json",
    );
    expect(() => detectWranglerConfig(new Set(["package.json"]))).toThrow(/not a Workers project/);
  });

  it("falls back to a config kept only as a template, which the packer copies to its real name", () => {
    expect(detectWranglerConfig(new Set(["wrangler.toml.example", "package.json"]))).toBe(
      "wrangler.toml.example",
    );
    expect(
      detectWranglerConfig(new Set(["wrangler.jsonc.template", "wrangler.toml.example"])),
    ).toBe("wrangler.jsonc.template");
    // A real config wins over any template.
    expect(detectWranglerConfig(new Set(["wrangler.jsonc.example", "wrangler.toml"]))).toBe(
      "wrangler.toml",
    );
  });

  it("lists the secrets of .dev.vars.example with their comments, skipping plain vars", () => {
    const secrets = parseSecretsExample(
      [
        "# Environment values. Copy to .dev.vars.",
        "",
        "# Password required to add links.",
        "ADMIN_PASSWORD=",
        "export API_KEY=example",
        "# Optional: where GET / goes.",
        "LANDING=",
        "HOME_PAGE=default",
        "not a line",
        "ADMIN_PASSWORD=again",
      ].join("\n"),
      ["HOME_PAGE"],
    );
    expect(secrets).toEqual([
      {
        name: "ADMIN_PASSWORD",
        label: "Admin password",
        help: "Password required to add links.",
        generate: false,
      },
      { name: "API_KEY", label: "Api key", generate: false },
      {
        name: "LANDING",
        label: "Landing",
        help: "Optional: where GET / goes.",
        generate: false,
        optional: true,
      },
    ]);
  });

  it("names things the catalog way", () => {
    expect(repositorySlug("Acme/My.Cool_App")).toBe("my-cool-app");
    expect(repositorySlug("acme/___")).toBe("app");
    expect(workerNameOf("Cut_App", "cut")).toBe("cut-app");
    expect(workerNameOf(null, "cut")).toBe("cut");
    expect(workerNameOf("x".repeat(80), "cut")).toHaveLength(54);
    expect(labelOf("adminPassword")).toBe("Admin password");
  });
});

describe("build command", () => {
  const pkg = readPackageFacts('{ "scripts": { "build": "vite build" }, "license": "MIT" }');

  it("runs package.json's build script with the project's package manager", () => {
    expect(chooseBuildCommand({ mode: "detect" }, "pnpm", pkg)).toEqual({
      command: "pnpm run build",
      from: "package.json",
    });
  });

  it("prefers a catalog app's own command, and the admin's over both", () => {
    expect(chooseBuildCommand({ mode: "detect" }, "pnpm", pkg, "pnpm build:web")).toEqual({
      command: "pnpm build:web",
      from: "catalog",
    });
    expect(
      chooseBuildCommand({ mode: "command", command: "npm run web" }, "pnpm", pkg, "x"),
    ).toEqual({ command: "npm run web", from: "entered" });
    expect(chooseBuildCommand({ mode: "none" }, "pnpm", pkg)).toEqual({
      command: null,
      from: "none",
    });
  });

  it("runs nothing without a build script", () => {
    expect(chooseBuildCommand({ mode: "detect" }, "npm", readPackageFacts("{}"))).toEqual({
      command: null,
      from: "none",
    });
  });
});

describe("artifactVersion", () => {
  const base = { sha: SHA, committedAt: "2026-09-20T23:30:00-02:00", now: 0 };

  it("takes a semver tag without its v, else the commit's UTC date and SHA", () => {
    expect(artifactVersion({ ...base, ref: "v1.4.0" })).toBe("1.4.0");
    expect(artifactVersion({ ...base, ref: "main" })).toBe("0.0.0-20260921.0123456");
    expect(artifactVersion({ ...base, ref: SHA })).toBe("0.0.0-20260921.0123456");
  });

  it("never reuses a version the install's builds already have", () => {
    expect(artifactVersion({ ...base, ref: "v1.4.0", avoid: ["1.4.0"] })).toBe("1.4.0+0123456");
    expect(
      artifactVersion({
        ...base,
        ref: "main",
        avoid: ["0.0.0-20260921.0123456", "0.0.0-20260921.0123456+0123456"],
      }),
    ).toBe("0.0.0-20260921.0123456+0123456.2");
  });
});

describe("manifests", () => {
  const facts = {
    repo: "MendyLanda/cut",
    ref: "main",
    sha: SHA,
    version: "0.0.0-20260921.0123456",
    packageManager: "pnpm" as const,
    wranglerConfig: "wrangler.jsonc",
    wrangler: { name: "cut", vars: ["HOME_PAGE"], unsupported: [], secrets: [] },
    pkg: readPackageFacts('{ "license": "MIT", "scripts": { "build": "x" } }'),
    buildCommand: "pnpm run build",
    secrets: parseSecretsExample("ADMIN_PASSWORD=\n"),
  };

  it("works out a valid sandbox tier manifest for a repository", () => {
    const manifest = repositoryManifest(facts);
    expect(catalogManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest).toMatchObject({
      slug: "cut",
      name: "MendyLanda/cut",
      homepage: "https://github.com/MendyLanda/cut",
      license: "MIT",
      source: { ref: "main", sha: SHA },
      install: {
        tier: "sandbox",
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        workerName: "cut",
        buildCommand: "pnpm run build",
        version: "0.0.0-20260921.0123456",
      },
      plan: "paid",
      requires: ["containers"],
      secrets: [{ name: "ADMIN_PASSWORD" }],
      vars: [{ name: "HOME_PAGE", label: "Home page", required: false }],
    });
  });

  it("keeps a catalog app's manifest for a build from source, with the new commit", () => {
    const baseline = catalogManifestSchema.parse({
      ...repositoryManifest(facts),
      slug: "cut",
      name: "Cut",
      source: { ref: "v0.1.0", sha: "f".repeat(40) },
      install: {
        tier: "artifact",
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        workerName: "cut",
        buildCommand: "pnpm build:css",
        version: "0.1.0",
      },
      plan: "free",
      requires: [],
    });
    const built = sourceBuildManifest(baseline, {
      ref: "main",
      sha: SHA,
      version: "0.0.0-20260921.0123456",
      buildCommand: null,
    });
    expect(catalogManifestSchema.parse(built)).toEqual(built);
    expect(built).toMatchObject({
      name: "Cut",
      plan: "free",
      source: { ref: "main", sha: SHA },
      install: { tier: "sandbox", version: "0.0.0-20260921.0123456" },
    });
    expect(built.install.buildCommand).toBeUndefined();
  });
});

describe("required secrets", () => {
  it("adds the secrets the wrangler config requires after the example file's, never optional", () => {
    const listed = parseSecretsExample(
      "# Optional: signs sessions.\nSESSION_SECRET=\n# Optional: for mail.\nSMTP_PASSWORD=\n",
    );
    expect(withRequiredSecrets(listed, ["SESSION_SECRET", "API_KEY", "API_KEY"])).toEqual([
      {
        name: "SESSION_SECRET",
        label: "Session secret",
        help: "Optional: signs sessions.",
        generate: false,
      },
      {
        name: "SMTP_PASSWORD",
        label: "Smtp password",
        help: "Optional: for mail.",
        generate: false,
        optional: true,
      },
      { name: "API_KEY", label: "Api key", generate: false },
    ]);
    expect(withRequiredSecrets([], [])).toEqual([]);
  });

  it("says where the secrets came from", () => {
    expect(secretsNote(".dev.vars.example", [])).toBe(" (from .dev.vars.example)");
    expect(secretsNote("none", ["API_KEY"])).toBe(" (from the wrangler config's secrets.required)");
    expect(secretsNote(".env.example", ["API_KEY"])).toBe(
      " (from .env.example and the wrangler config's secrets.required)",
    );
    expect(secretsNote("catalog", [])).toBe(" (from catalog)");
    expect(secretsNote("none", [])).toBe("");
  });
});
