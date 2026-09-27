import { SANDBOX_FEATURE_D1_SEED } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { d1SeedRefusal } from "./binding";

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
