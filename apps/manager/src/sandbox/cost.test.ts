import { describe, expect, it } from "vitest";
import {
  buildCostLine,
  buildCostSentence,
  describeInstance,
  estimateBuild,
  estimatedMinutes,
  formatUsd,
  installerCostSentence,
} from "./cost";

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

  it("says what a build runs on and costs, with the minutes worded as an estimate", () => {
    expect(buildCostSentence(estimateBuild("standard-1", 5))).toBe(
      "Each build runs a standard-1 (1/2 vCPU, 4 GiB memory, 8 GB disk) container for an estimated 5 minutes (the catalog's estimate; a build is billed for as long as it actually runs). A build of that length costs about US$0.006 beyond the container usage Workers Paid includes each month (enough for about 75 such builds). A build whose container stops or times out runs once more, which costs as much again.",
    );
  });

  it("shortens it to one line for an app page and the sandbox builds card", () => {
    expect(buildCostLine(estimateBuild())).toBe(
      "standard-1 (1/2 vCPU, 4 GiB memory, 8 GB disk) for an estimated 10 minutes: about US$0.012 a build of that length beyond the included usage",
    );
  });

  it("words an installer run's minutes as an estimate too", () => {
    const sentence = installerCostSentence(estimateBuild("standard-1", 12));
    expect(sentence).toContain("for an estimated 12 minutes (the catalog's estimate;");
    expect(sentence).not.toMatch(/for about \d+ minutes/);
  });

  it("formats the estimated minutes", () => {
    expect(estimatedMinutes(1)).toBe("an estimated 1 minute");
    expect(estimatedMinutes(25)).toBe("an estimated 25 minutes");
  });
});
