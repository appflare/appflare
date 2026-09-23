import { describe, expect, it } from "vitest";
import { indexAppArtifact, indexAppSchema, indexJsonSchema } from "./catalog-index";

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

describe("indexAppSchema for sandbox tier entries", () => {
  const [artifactApp] = validIndex.apps;
  if (artifactApp === undefined) throw new Error("the fixture index has no app");
  const sandboxApp = {
    slug: "flaremo",
    name: "FlareMo",
    summary: "Memos on Workers.",
    version: "0.20.1",
    tier: "sandbox",
    plan: "paid",
    requires: [],
    lastVerified: null,
    maintainers: ["someone"],
    build: {
      pin: "a".repeat(40),
      manifest: "https://appflare.github.io/catalog/apps/flaremo/appflare.json",
      manifestDigest: "d".repeat(64),
      buildCommand: "pnpm build",
      expectedMinutes: 12,
      instanceType: "standard-2",
    },
  };

  it("accepts a sandbox entry without artifacts or digest", () => {
    const parsed = indexAppSchema.parse(sandboxApp);
    expect(parsed.build?.expectedMinutes).toBe(12);
    expect(indexAppArtifact(parsed)).toBeNull();
  });

  it("keeps artifact tier entries unchanged", () => {
    const parsed = indexAppSchema.parse(artifactApp);
    expect(parsed).toEqual(artifactApp);
    expect(indexAppArtifact(parsed)?.digest).toBe("c".repeat(64));
  });

  it("refuses an artifact entry without artifacts, and a sandbox entry without build", () => {
    const { artifacts: _a, digest: _d, ...bare } = artifactApp;
    expect(indexAppSchema.safeParse(bare).success).toBe(false);
    const { build: _b, ...unbuilt } = sandboxApp;
    expect(indexAppSchema.safeParse(unbuilt).success).toBe(false);
  });

  it("refuses artifacts without a digest", () => {
    const { digest: _d, ...half } = artifactApp;
    expect(
      indexAppSchema.safeParse({ ...half, tier: "sandbox", build: sandboxApp.build }).success,
    ).toBe(false);
  });

  it("refuses a build with a short pin or an unknown instance type", () => {
    expect(
      indexAppSchema.safeParse({ ...sandboxApp, build: { ...sandboxApp.build, pin: "abc" } })
        .success,
    ).toBe(false);
    expect(
      indexAppSchema.safeParse({
        ...sandboxApp,
        build: { ...sandboxApp.build, instanceType: "basic" },
      }).success,
    ).toBe(false);
  });
});
