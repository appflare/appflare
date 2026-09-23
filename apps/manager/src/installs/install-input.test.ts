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

describe("instanceName", () => {
  const base = { slug: "cut", workerName: "cut", secrets: {}, vars: {}, paidConfirmed: false };

  it("is optional, trimmed, and 1 to 64 characters", () => {
    expect(startInstallInput.parse(base).instanceName).toBeUndefined();
    expect(startInstallInput.parse({ ...base, instanceName: "  Team links " }).instanceName).toBe(
      "Team links",
    );
    expect(startInstallInput.safeParse({ ...base, instanceName: "   " }).success).toBe(false);
    expect(startInstallInput.safeParse({ ...base, instanceName: "x".repeat(64) }).success).toBe(
      true,
    );
    expect(startInstallInput.safeParse({ ...base, instanceName: "x".repeat(65) }).success).toBe(
      false,
    );
  });
});
