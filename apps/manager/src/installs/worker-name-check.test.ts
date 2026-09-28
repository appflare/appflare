import { describe, expect, it } from "vitest";
import {
  ACCOUNT_NAME_MESSAGE,
  INSTALLED_NAME_MESSAGE,
  workerNameAllowsInstall,
  workerNameFormatProblem,
  workerNameVerdict,
} from "./worker-name-check";

const taken = { installed: ["sink"], account: ["sink", "appflare", "blog"] };

describe("workerNameFormatProblem", () => {
  it("accepts DNS labels of lowercase letters, digits and inner dashes", () => {
    for (const ok of ["a", "sink-2", "x".repeat(54)])
      expect(workerNameFormatProblem(ok)).toBeNull();
  });

  it("says why anything else is refused", () => {
    expect(workerNameFormatProblem("")).toBe("Enter a name.");
    for (const bad of ["Sink", "-sink", "sink-", "my sink", "x".repeat(55), "sïnk"]) {
      expect(workerNameFormatProblem(bad), bad).toMatch(/^Use 1 to 54 lowercase letters/);
    }
  });
});

describe("workerNameVerdict", () => {
  it("is invalid before anything else", () => {
    expect(workerNameVerdict("Sink", taken)).toEqual({
      state: "invalid",
      message: expect.stringMatching(/^Use /),
    });
    expect(workerNameVerdict("", null).state).toBe("invalid");
  });

  it("is taken by an app installed here, or by another Worker in the account", () => {
    expect(workerNameVerdict("sink", taken)).toEqual({
      state: "taken",
      message: INSTALLED_NAME_MESSAGE,
    });
    expect(workerNameVerdict("blog", taken)).toEqual({
      state: "taken",
      message: ACCOUNT_NAME_MESSAGE,
    });
  });

  it("is free when no Worker has the name", () => {
    expect(workerNameVerdict("sink-2", taken)).toEqual({ state: "free" });
  });

  it("is unknown when the names could not be read, except for a name an install here holds", () => {
    expect(workerNameVerdict("sink-2", null)).toEqual({ state: "unknown" });
    expect(workerNameVerdict("sink-2", { installed: ["sink"], account: null })).toEqual({
      state: "unknown",
    });
    expect(workerNameVerdict("sink", { installed: ["sink"], account: null }).state).toBe("taken");
  });
});

describe("workerNameAllowsInstall", () => {
  it("holds the install back only for an invalid or taken name", () => {
    expect(workerNameAllowsInstall({ state: "free" })).toBe(true);
    expect(workerNameAllowsInstall({ state: "checking" })).toBe(true);
    expect(workerNameAllowsInstall({ state: "unknown" })).toBe(true);
    expect(workerNameAllowsInstall({ state: "invalid", message: "x" })).toBe(false);
    expect(workerNameAllowsInstall({ state: "taken", message: "x" })).toBe(false);
  });
});
