import { describe, expect, it } from "vitest";
import { generateTemporaryPassword, TEMPORARY_PASSWORD_LENGTH } from "./temporary-password";

describe("generateTemporaryPassword", () => {
  it("has the documented length and only unambiguous characters", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateTemporaryPassword();
      expect(pw).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      expect(pw).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(200);
  });
});
