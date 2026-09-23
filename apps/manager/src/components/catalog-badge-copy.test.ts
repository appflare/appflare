import { planSchema } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { installCheckBadgeCopy, PLAN_BADGES } from "./catalog-badge-copy";

describe("installCheckBadgeCopy", () => {
  // Midday UTC, so the day is the same in whatever time zone the tests run.
  const lastVerified = "2026-09-23T12:34:56.000Z";

  it("puts the day on the badge and what the check did, to the second, in the tooltip", () => {
    const copy = installCheckBadgeCopy(lastVerified);
    expect(copy.checked).toBe(true);
    expect(copy.label).toBe("Install checked Sep 23, 2026");
    expect(copy.tooltip).toMatch(
      /^The catalog's nightly job reinstalled this exact package into a test account on September 23, 2026 at 12:34:56\sPM UTC, and it answered\.$/,
    );
  });

  it("says the app is not checked yet when the index has no date", () => {
    const copy = installCheckBadgeCopy(null);
    expect(copy.checked).toBe(false);
    expect(copy.label).toBe("Not checked yet");
    expect(copy.tooltip).toBe(
      "The catalog's nightly job has not yet reinstalled this version into a test account and seen it answer.",
    );
  });

  it("never says verified, the word for an install's own health in this account", () => {
    for (const copy of [installCheckBadgeCopy(lastVerified), installCheckBadgeCopy(null)]) {
      expect(`${copy.label} ${copy.tooltip}`).not.toMatch(/verified/i);
    }
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
