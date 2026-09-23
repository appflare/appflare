import { describe, expect, it } from "vitest";
import { buildCostSentence, describeInstance, estimateBuild, formatUsd } from "./cost";

describe("estimateBuild", () => {
  it("prices a 10-minute standard-1 build at about US$0.012, about 35 a month included", () => {
    const e = estimateBuild("standard-1", 10);
    expect(e.usd).toBeCloseTo(0.012336, 6);
    expect(formatUsd(e.usd)).toBe("US$0.012");
    expect(e.includedBuilds).toBe(35);
    expect(describeInstance(e)).toBe("standard-1 (1/2 vCPU, 4 GiB memory, 8 GB disk)");
  });

  it("prices a 10-minute standard-2 build at about US$0.022", () => {
    const e = estimateBuild("standard-2", 10);
    expect(formatUsd(e.usd)).toBe("US$0.022");
    expect(e.includedBuilds).toBe(25);
  });

  it("defaults to standard-1 for 10 minutes and scales with the minutes", () => {
    expect(estimateBuild()).toEqual(estimateBuild("standard-1", 10));
    expect(estimateBuild("standard-1", 20).usd).toBeCloseTo(2 * estimateBuild().usd, 9);
    expect(formatUsd(1.234)).toBe("US$1.23");
  });

  it("says what a build runs on and costs", () => {
    expect(buildCostSentence(estimateBuild("standard-1", 5))).toBe(
      "Each build runs a standard-1 (1/2 vCPU, 4 GiB memory, 8 GB disk) container for about 5 minutes, which costs about US$0.006 beyond the container usage Workers Paid includes each month (enough for about 75 such builds). A build whose container stops or times out runs once more, which costs as much again.",
    );
  });
});
