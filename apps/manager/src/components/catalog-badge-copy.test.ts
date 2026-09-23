import { planSchema } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { PLAN_BADGES, verifiedBadgeCopy } from "./catalog-badge-copy";

describe("verifiedBadgeCopy", () => {
  // Midday UTC, so the day is the same in whatever time zone the tests run.
  const lastVerified = "2026-09-23T12:34:56.000Z";

  it("puts the day on the badge and the exact time in the tooltip", () => {
    const copy = verifiedBadgeCopy(lastVerified);
    expect(copy.verified).toBe(true);
    expect(copy.label).toBe("Verified Sep 23, 2026");
    expect(copy.tooltip).toMatch(/^Install check passed September 23, 2026 at 12:34:56\sPM UTC\.$/);
  });

  it("says the app is not verified yet when the index has no date", () => {
    const copy = verifiedBadgeCopy(null);
    expect(copy.verified).toBe(false);
    expect(copy.label).toBe("Not verified yet");
    expect(copy.tooltip).toBe(
      "The catalog's nightly install check has not passed for this version yet.",
    );
  });
});

describe("PLAN_BADGES", () => {
  it("names every plan the index can carry", () => {
    expect(planSchema.options.map((plan) => PLAN_BADGES[plan].label)).toEqual([
      "Free plan",
      "Workers Paid",
    ]);
  });
});
