import { describe, expect, it } from "vitest";
import { WORKER_NAME_PATTERN } from "./install-input";

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
