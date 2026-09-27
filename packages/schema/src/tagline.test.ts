import { describe, expect, it } from "vitest";
import { catalogManifestSchema } from "./catalog";
import { indexAppSchema } from "./catalog-index";
import { REVISABLE_CATALOG_FIELDS } from "./revision";
import { MAX_TAGLINE_LENGTH, taglineSchema } from "./tagline";

const manifest = {
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
  secrets: [],
  vars: [],
  postInstall: [],
  tokenPermissions: [],
};

const row = {
  slug: "cut",
  name: "Cut",
  summary: "Self-hosted link shortener on Workers + KV.",
  version: "0.1.0",
  build: {
    pin: "0".repeat(40),
    manifest: "https://appflare.github.io/catalog/apps/cut/appflare.json",
    manifestDigest: "c".repeat(64),
  },
  tier: "sandbox",
  plan: "paid",
  requires: [],
  lastVerified: null,
  maintainers: ["MendyLanda"],
};

describe("taglineSchema", () => {
  it("accepts one plain line of up to the limit without a trailing period", () => {
    expect(taglineSchema.parse("Short links on your own domain")).toBe(
      "Short links on your own domain",
    );
    expect(taglineSchema.safeParse("a".repeat(MAX_TAGLINE_LENGTH)).success).toBe(true);
    expect(taglineSchema.safeParse("Is it up? Find out").success).toBe(true);
  });

  it("refuses an empty, long, padded, multi-line or period-ended tagline", () => {
    for (const bad of [
      "",
      "a".repeat(MAX_TAGLINE_LENGTH + 1),
      " Short links",
      "Short links ",
      "Short links\non your domain",
      "Short links on your own domain.",
    ]) {
      expect(taglineSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("tagline and addedAt on entries", () => {
  it("are optional in the catalog manifest, and a tagline is revisable copy", () => {
    expect(catalogManifestSchema.parse(manifest).tagline).toBeUndefined();
    const parsed = catalogManifestSchema.parse({ ...manifest, tagline: "Short links" });
    expect(parsed.tagline).toBe("Short links");
    expect(catalogManifestSchema.safeParse({ ...manifest, tagline: "Short links." }).success).toBe(
      false,
    );
    expect(REVISABLE_CATALOG_FIELDS).toContain("tagline");
  });

  it("are optional on an index row, which checks both", () => {
    const before = indexAppSchema.parse(row);
    expect(before.tagline).toBeUndefined();
    expect(before.addedAt).toBeUndefined();
    const after = indexAppSchema.parse({
      ...row,
      tagline: "Short links",
      addedAt: "2026-09-21T10:00:00Z",
    });
    expect(after).toMatchObject({ tagline: "Short links", addedAt: "2026-09-21T10:00:00Z" });
    expect(indexAppSchema.safeParse({ ...row, addedAt: "2026-09-21T10:00:00+03:00" }).success).toBe(
      true,
    );
    expect(indexAppSchema.safeParse({ ...row, addedAt: "last week" }).success).toBe(false);
    expect(indexAppSchema.safeParse({ ...row, tagline: "x".repeat(81) }).success).toBe(false);
  });
});
