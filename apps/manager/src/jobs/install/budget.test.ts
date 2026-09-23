import { describe, expect, it } from "vitest";
import {
  fetchCost,
  isSubrequestLimitError,
  SUBREQUEST_BUDGET,
  SubrequestBudget,
  subrequestLimitMessage,
} from "./budget";

describe("SubrequestBudget", () => {
  it("asks for a boundary before a phase would take the count past 40", () => {
    const budget = new SubrequestBudget();
    expect(SUBREQUEST_BUDGET).toBe(40);
    expect(budget.needsBoundary(39)).toBe(false);
    budget.add(30);
    expect(budget.needsBoundary(10)).toBe(false);
    expect(budget.needsBoundary(11)).toBe(true);
    expect(budget.boundary()).toBe(1);
    expect(budget.used).toBe(0);
    budget.add(5);
    expect(budget.boundary()).toBe(2);
  });

  it("never asks for a boundary in a fresh invocation, even for a phase over the limit", () => {
    const budget = new SubrequestBudget();
    expect(budget.needsBoundary(45)).toBe(false);
  });

  it("reset() starts a fresh count without a named boundary", () => {
    const budget = new SubrequestBudget(10);
    budget.add(9);
    budget.reset();
    expect(budget.needsBoundary(10)).toBe(false);
    expect(budget.boundary()).toBe(1);
  });

  it("recognizes the runtime's subrequest-limit error, also when wrapped", () => {
    const limit = new Error("Too many subrequests by single Worker invocation.");
    expect(isSubrequestLimitError(limit)).toBe(true);
    expect(isSubrequestLimitError(new Error("GET x failed", { cause: limit }))).toBe(true);
    expect(isSubrequestLimitError(new Error("GET x -> 503"))).toBe(false);
    expect(isSubrequestLimitError(null)).toBe(false);
  });

  it("explains why a subrequest-limit failure is not retried", () => {
    expect(
      subrequestLimitMessage(
        "GET a.js failed: Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits",
      ),
    ).toBe(
      "GET a.js failed: Too many subrequests by single Worker invocation. Cloudflare allows 50 subrequests per Worker invocation on the free plan, and a retry would run in the same invocation and hit the same limit, so the job stopped instead of retrying.",
    );
  });

  it("counts a redirected fetch as two subrequests", () => {
    expect(fetchCost({ redirected: false })).toBe(1);
    expect(fetchCost({ redirected: true })).toBe(2);
  });
});
