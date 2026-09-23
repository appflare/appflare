import { describe, expect, it } from "vitest";
import { appHealthPath, catalogManifestSchema, hasFixedWorkerName, semverSchema } from "./catalog";

const validManifest = {
  $schema: "https://appflare.github.io/catalog/schema/v1.json",
  slug: "cut",
  name: "Cut",
  summary: "Self-hosted link shortener on Workers + KV.",
  homepage: "https://github.com/MendyLanda/cut",
  repo: "MendyLanda/cut",
  license: "MIT",
  categories: ["utilities"],
  maintainers: ["MendyLanda"],
  source: { ref: "v0.1.0", sha: "0".repeat(40) },
  install: {
    tier: "artifact",
    packageManager: "pnpm",
    wranglerConfig: "wrangler.jsonc",
    workerName: "cut",
  },
  plan: "free",
  requires: [],
  secrets: [
    {
      name: "ADMIN_PASSWORD",
      label: "Admin password",
      help: "Sign in to the admin UI.",
      generate: true,
    },
  ],
  vars: [],
  postInstall: [{ type: "markdown", content: "Open {{workerUrl}} and sign in." }],
  tokenPermissions: [],
};

describe("catalogManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const parsed = catalogManifestSchema.parse(validManifest);
    expect(parsed.slug).toBe("cut");
    expect(parsed.install.tier).toBe("artifact");
    // `generate` defaults to false when omitted.
    expect(parsed.secrets[0]?.generate).toBe(true);
  });

  it("requires an https homepage", () => {
    for (const homepage of ["http://example.com", "javascript:alert(1)", "ftp://example.com"]) {
      expect(catalogManifestSchema.safeParse({ ...validManifest, homepage }).success).toBe(false);
    }
  });

  it("rejects an invalid manifest (bad plan enum and short sha)", () => {
    const invalid = {
      ...validManifest,
      plan: "enterprise",
      source: { ref: "v0.1.0", sha: "abc" },
    };
    const result = catalogManifestSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("treats fixedWorkerName as optional and false when omitted", () => {
    const omitted = catalogManifestSchema.parse(validManifest);
    expect(omitted.install.fixedWorkerName).toBeUndefined();
    expect(hasFixedWorkerName(omitted.install)).toBe(false);

    const fixed = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, fixedWorkerName: true },
    });
    expect(hasFixedWorkerName(fixed.install)).toBe(true);

    const notFixed = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, fixedWorkerName: false },
    });
    expect(hasFixedWorkerName(notFixed.install)).toBe(false);
  });

  it("takes an optional healthPath, defaulting to /", () => {
    const omitted = catalogManifestSchema.parse(validManifest);
    expect(omitted.install.healthPath).toBeUndefined();
    expect(appHealthPath(omitted.install)).toBe("/");
    const set = catalogManifestSchema.parse({
      ...validManifest,
      install: { ...validManifest.install, healthPath: "/api/health" },
    });
    expect(appHealthPath(set.install)).toBe("/api/health");
    for (const healthPath of ["api/health", "/a b", "/x?y=1", ""]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, healthPath },
      });
      expect(result.success).toBe(false);
    }
  });

  it("takes an optional semver install.version without a leading v", () => {
    expect(catalogManifestSchema.parse(validManifest).install.version).toBeUndefined();
    for (const version of ["1.1.10", "0.0.1", "2.0.0-rc.1", "1.0.0+build.5"]) {
      const parsed = catalogManifestSchema.parse({
        ...validManifest,
        install: { ...validManifest.install, version },
      });
      expect(parsed.install.version).toBe(version);
    }
    for (const version of ["v1.1.10", "1.1", "01.2.3", "1.2.3-", "latest", "", 1]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, version },
      });
      expect(result.success).toBe(false);
    }
  });

  it("takes optional Vectorize index settings keyed by binding", () => {
    expect(catalogManifestSchema.parse(validManifest).resources).toBeUndefined();
    const parsed = catalogManifestSchema.parse({
      ...validManifest,
      resources: { vectorize: { VECTORIZE: { dimensions: 384, metric: "cosine" } } },
    });
    expect(parsed.resources?.vectorize?.VECTORIZE).toEqual({ dimensions: 384, metric: "cosine" });
    for (const metric of ["euclidean", "dot-product"]) {
      const ok = catalogManifestSchema.safeParse({
        ...validManifest,
        resources: { vectorize: { V: { dimensions: 1536, metric } } },
      });
      expect(ok.success).toBe(true);
    }
    for (const index of [
      { dimensions: 0, metric: "cosine" },
      { dimensions: 1537, metric: "cosine" },
      { dimensions: 384.5, metric: "cosine" },
      { dimensions: 384, metric: "dot" },
      { dimensions: 384 },
      { metric: "cosine" },
    ]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        resources: { vectorize: { V: index } },
      });
      expect(result.success).toBe(false);
    }
  });

  it("takes optional bump settings with a boolean autoMerge", () => {
    expect(catalogManifestSchema.parse(validManifest).bump).toBeUndefined();
    for (const autoMerge of [true, false]) {
      const parsed = catalogManifestSchema.parse({ ...validManifest, bump: { autoMerge } });
      expect(parsed.bump).toEqual({ autoMerge });
    }
    for (const bump of [{}, { autoMerge: "yes" }, { autoMerge: 1 }, { autoMerge: null }, true]) {
      expect(catalogManifestSchema.safeParse({ ...validManifest, bump }).success).toBe(false);
    }
  });

  it("rejects a non-boolean fixedWorkerName", () => {
    for (const fixedWorkerName of ["yes", 1, null]) {
      const result = catalogManifestSchema.safeParse({
        ...validManifest,
        install: { ...validManifest.install, fixedWorkerName },
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("semverSchema", () => {
  it("accepts semver without a leading v and nothing else", () => {
    expect(semverSchema.safeParse("11.0.0").success).toBe(true);
    expect(semverSchema.safeParse("1.2.3-beta.1+sha.abc").success).toBe(true);
    expect(semverSchema.safeParse("v11.0.0").success).toBe(false);
    expect(semverSchema.safeParse(" 1.2.3").success).toBe(false);
  });
});
