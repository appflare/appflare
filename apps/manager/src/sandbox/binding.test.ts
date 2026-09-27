import { SANDBOX_FEATURE_D1_BASELINE, SANDBOX_FEATURE_D1_SEED } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { d1BaselineRefusal, d1SeedRefusal } from "./binding";

describe("d1SeedRefusal", () => {
  const seeded = { resources: { d1: { DB: { seed: { statements: [] } } } } };

  it("refuses an entry with a seed on a sandbox Worker that would build it without one", () => {
    expect(d1SeedRefusal({ sandboxVersion: "0.1.5", features: [] }, seeded, "update it")).toBe(
      "the sandbox Worker 0.1.5 cannot build an app that seeds its database (resources.d1 seed) and would build it without the seed; to update it, update it",
    );
  });

  it("builds it on a sandbox Worker that keeps seeds, and any entry without one anywhere", () => {
    const current = { sandboxVersion: "0.1.6", features: [SANDBOX_FEATURE_D1_SEED] };
    expect(d1SeedRefusal(current, seeded, "update it")).toBeNull();
    const old = { sandboxVersion: "0.1.5", features: [] };
    expect(d1SeedRefusal(old, { resources: { d1: { DB: {} } } }, "update it")).toBeNull();
    expect(d1SeedRefusal(old, undefined, "update it")).toBeNull();
  });
});

describe("d1BaselineRefusal", () => {
  const withBaseline = { resources: { d1: { DB: { baseline: "schema.sql" } } } };
  const old = { sandboxVersion: "0.1.6", features: [SANDBOX_FEATURE_D1_SEED] };

  it("refuses an entry with a baseline on a sandbox Worker that would build it without one", () => {
    expect(d1BaselineRefusal(old, withBaseline, "update it")).toBe(
      "the sandbox Worker 0.1.6 cannot build an app with a D1 baseline (resources.d1 baseline) and would build it without one; to update it, update it",
    );
  });

  it("builds it on a sandbox Worker that keeps baselines, and any entry without one anywhere", () => {
    const current = { sandboxVersion: "0.1.7", features: [SANDBOX_FEATURE_D1_BASELINE] };
    expect(d1BaselineRefusal(current, withBaseline, "update it")).toBeNull();
    expect(d1BaselineRefusal(old, { resources: { d1: { DB: {} } } }, "update it")).toBeNull();
    expect(d1BaselineRefusal(old, undefined, "update it")).toBeNull();
  });
});
