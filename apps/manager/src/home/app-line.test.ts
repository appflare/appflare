import { describe, expect, it } from "vitest";
import { appLine } from "./app-line";

const NOW = new Date("2026-09-27T12:00:00");
const running = { status: "installed", version: "0.3.0", updatedAt: "2026-09-24T12:00:00" };

describe("appLine", () => {
  it("says a healthy app runs, with its version and when it last changed", () => {
    expect(appLine(running, undefined, NOW)).toBe("Running · 0.3.0 · updated 3 days ago");
    expect(appLine({ ...running, updatedAt: "2026-09-27T08:00:00" }, undefined, NOW)).toBe(
      "Running · 0.3.0 · updated today",
    );
  });

  it("puts what needs attention first, the most severe of it", () => {
    expect(appLine(running, "update", NOW)).toBe("Update available");
    expect(appLine(running, "not-responding", NOW)).toBe("Not responding");
    expect(appLine(running, "failed", NOW)).toBe("Last change did not finish");
  });

  it("says what is happening to an app that is not simply installed", () => {
    expect(appLine({ ...running, status: "installing" }, undefined, NOW)).toBe("Installing");
    expect(appLine({ ...running, status: "updating" }, "update", NOW)).toBe("Updating");
    expect(appLine({ ...running, status: "failed" }, "failed", NOW)).toBe("Install did not finish");
    expect(appLine({ ...running, status: "uninstalling" }, undefined, NOW)).toBe("Being removed");
    expect(appLine({ ...running, status: "uninstalling" }, "failed", NOW)).toBe(
      "Removal did not finish",
    );
  });
});
