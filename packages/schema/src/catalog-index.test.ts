import { describe, expect, it } from "vitest";
import { indexJsonSchema } from "./catalog-index";

const base = "https://github.com/appflare/catalog/releases/download/cut@0.1.0";

const validIndex = {
  generatedAt: "2026-09-22T12:00:00Z",
  apps: [
    {
      slug: "cut",
      name: "Cut",
      summary: "Self-hosted link shortener on Workers + KV.",
      version: "0.1.0",
      artifacts: {
        zip: `${base}/cut-0.1.0.zip`,
        manifest: `${base}/manifest.json`,
        sig: `${base}/manifest.sig`,
      },
      digest: "c".repeat(64),
      tier: "artifact",
      plan: "free",
      requires: [],
      lastVerified: null,
      maintainers: ["MendyLanda"],
    },
  ],
};

describe("indexJsonSchema", () => {
  it("accepts a valid index.json", () => {
    const parsed = indexJsonSchema.parse(validIndex);
    expect(parsed.apps[0]?.slug).toBe("cut");
    expect(parsed.apps[0]?.lastVerified).toBeNull();
  });

  it("rejects an index with a non-URL artifact and unknown tier", () => {
    const invalid = {
      ...validIndex,
      apps: [
        {
          ...validIndex.apps[0],
          tier: "docker",
          artifacts: { zip: "not a url", manifest: "x", sig: "y" },
        },
      ],
    };
    const result = indexJsonSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
