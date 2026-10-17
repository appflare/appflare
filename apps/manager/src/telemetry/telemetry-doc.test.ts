import { describe, expect, it } from "vitest";
import { ERROR_CATEGORIES, FAILED_PHASES, FAILURE_REASONS } from "./classify";

/** The docs page that says what usage data carries, read at build time. */
const doc = Object.values(
  import.meta.glob<string>("../../../docs/content/docs/telemetry.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0];

describe("the usage data page", () => {
  it("lists every error category, phase and reason a failed job can carry", () => {
    expect(doc).toBeDefined();
    const text = (doc ?? "").replace(/\s+/g, " ");
    for (const value of [...ERROR_CATEGORIES, ...FAILED_PHASES, ...FAILURE_REASONS]) {
      expect(text, value).toContain(`\`${value}\``);
    }
  });
});
