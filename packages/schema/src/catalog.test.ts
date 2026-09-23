import { describe, expect, it } from "vitest";
import { catalogManifestSchema } from "./catalog";

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
});
