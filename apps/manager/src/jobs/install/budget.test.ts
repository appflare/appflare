import { describe, expect, it } from "vitest";
import { fetchCost, SUBREQUEST_BUDGET, SubrequestBudget } from "./budget";

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

  it("counts a redirected fetch as two subrequests", () => {
    expect(fetchCost({ redirected: false })).toBe(1);
    expect(fetchCost({ redirected: true })).toBe(2);
  });
});
