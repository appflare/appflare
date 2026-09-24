import { describe, expect, it } from "vitest";
import { startInstallInput, WORKER_NAME_PATTERN } from "./install-input";

describe("WORKER_NAME_PATTERN", () => {
  it("accepts DNS labels of up to 54 characters", () => {
    for (const ok of ["cut", "a", "my-app-2", "a".repeat(54)]) {
      expect(WORKER_NAME_PATTERN.test(ok)).toBe(true);
    }
  });

  it("rejects leading or trailing dashes, other characters, and long names", () => {
    for (const bad of ["-cut", "cut-", "-", "", "Cut", "my_app", "a".repeat(55)]) {
      expect(WORKER_NAME_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("requirementsConfirmed", () => {
  const base = { slug: "cut", workerName: "cut", secrets: {}, vars: {}, paidConfirmed: false };

  it("defaults to false for a client that does not send it", () => {
    expect(startInstallInput.parse(base).requirementsConfirmed).toBe(false);
    expect(
      startInstallInput.parse({ ...base, requirementsConfirmed: true }).requirementsConfirmed,
    ).toBe(true);
  });
});

describe("displayName", () => {
  const base = { slug: "cut", workerName: "cut", secrets: {}, vars: {}, paidConfirmed: false };
  const parse = (displayName: string) => startInstallInput.safeParse({ ...base, displayName });

  it("is optional; empty or only spaces means none", () => {
    expect(startInstallInput.parse(base).displayName).toBeUndefined();
    expect(parse("").data?.displayName).toBeNull();
    expect(parse("   ").data?.displayName).toBeNull();
  });

  it("is trimmed, 1 to 60 characters, without control characters", () => {
    expect(parse("  Team links ").data?.displayName).toBe("Team links");
    expect(parse("x".repeat(60)).success).toBe(true);
    expect(parse(` ${"x".repeat(60)} `).success).toBe(true);
    expect(parse("x".repeat(61)).success).toBe(false);
    expect(parse("Team\nlinks").success).toBe(false);
    expect(parse("Team\tlinks").success).toBe(false);
    expect(parse("Team\u0000links").success).toBe(false);
  });
});
