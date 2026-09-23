import { describe, expect, it } from "vitest";
import {
  ARTIFACT_FETCH_SUBREQUESTS,
  FREE_PLAN_SUBREQUESTS,
  MAX_WORKER_MODULES,
  tooManyModulesMessage,
  WORKER_UPLOAD_OVERHEAD_SUBREQUESTS,
} from "./limits";

describe("MAX_WORKER_MODULES", () => {
  it("is the most modules whose fetches and the upload fit one free-plan invocation", () => {
    expect(MAX_WORKER_MODULES).toBe(21);
    const cost = (n: number) => n * ARTIFACT_FETCH_SUBREQUESTS + WORKER_UPLOAD_OVERHEAD_SUBREQUESTS;
    expect(cost(MAX_WORKER_MODULES)).toBeLessThanOrEqual(FREE_PLAN_SUBREQUESTS);
    expect(cost(MAX_WORKER_MODULES + 1)).toBeGreaterThan(FREE_PLAN_SUBREQUESTS);
  });
});

describe("tooManyModulesMessage", () => {
  it("accepts up to the limit", () => {
    expect(tooManyModulesMessage(1)).toBeNull();
    expect(tooManyModulesMessage(MAX_WORKER_MODULES)).toBeNull();
  });

  it("names the count, the limit, and the remedy", () => {
    expect(tooManyModulesMessage(84, "The release")).toBe(
      "The release has 84 Worker modules, but one upload can fetch at most 21 within the free plan's 50 subrequests per invocation (2 per module from a release asset). It must be built as 21 or fewer modules, for example as one bundled module.",
    );
  });

  it("takes another limit", () => {
    expect(tooManyModulesMessage(3, undefined, 2)).toMatch(/^The artifact has 3 Worker modules/);
    expect(tooManyModulesMessage(2, undefined, 2)).toBeNull();
  });
});
