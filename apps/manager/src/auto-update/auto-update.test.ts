import { describe, expect, it } from "vitest";
import {
  type AutoUpdateCandidate,
  effectiveAutoUpdate,
  MAX_APP_ATTEMPTS_PER_RUN,
  NEEDS_ADMIN_COPY,
  planAppUpdates,
  planSelfUpdate,
  planUpdateAll,
  settingOn,
  startedByLabel,
  unattendedUpdateBlock,
} from "./auto-update";

function candidate(over: Partial<AutoUpdateCandidate> = {}): AutoUpdateCandidate {
  return {
    installId: "i1",
    status: "installed",
    buildKind: "artifact",
    choice: "inherit",
    version: "1.0.0",
    latest: { version: "1.1.0", tier: "artifact" },
    triedBefore: null,
    waiting: null,
    ...over,
  };
}

describe("effectiveAutoUpdate", () => {
  it("follows the account default unless the install overrides it", () => {
    expect(effectiveAutoUpdate("inherit", false)).toBe(false);
    expect(effectiveAutoUpdate("inherit", true)).toBe(true);
    expect(effectiveAutoUpdate("on", false)).toBe(true);
    expect(effectiveAutoUpdate("off", true)).toBe(false);
  });

  it("reads a stored setting as off unless it says on", () => {
    expect(settingOn("on")).toBe(true);
    expect(settingOn("off")).toBe(false);
    expect(settingOn(undefined)).toBe(false);
    expect(settingOn("yes")).toBe(false);
  });
});

describe("planAppUpdates", () => {
  it("tries an installed artifact app with a newer catalog version when its setting is on", () => {
    expect(planAppUpdates([candidate()], true)).toEqual([
      { installId: "i1", action: "try", version: "1.1.0" },
    ]);
    expect(planAppUpdates([candidate({ choice: "on" })], false)).toEqual([
      { installId: "i1", action: "try", version: "1.1.0" },
    ]);
  });

  it("says why it leaves an install alone", () => {
    const reasons = planAppUpdates(
      [
        candidate({ installId: "default-off" }),
        candidate({ installId: "own-off", choice: "off" }),
        candidate({ installId: "busy", choice: "on", status: "updating" }),
        candidate({ installId: "failed", choice: "on", status: "failed" }),
        candidate({ installId: "unlisted", choice: "on", latest: null }),
        candidate({
          installId: "current",
          choice: "on",
          latest: { version: "1.0.0", tier: "artifact" },
        }),
        candidate({
          installId: "older",
          choice: "on",
          latest: { version: "0.9.0", tier: "artifact" },
        }),
        candidate({ installId: "sandbox", choice: "on", buildKind: "sandbox" }),
        candidate({
          installId: "now-sandbox",
          choice: "on",
          latest: { version: "1.1.0", tier: "sandbox" },
        }),
        candidate({
          installId: "installer",
          choice: "on",
          buildKind: "self-deploying",
          latest: { version: "1.1.0", tier: "self-deploying" },
        }),
        // The entry moved from its own installer to a release (OpenSEO 0.1.10), or back.
        candidate({ installId: "no-installer", choice: "on", buildKind: "self-deploying" }),
        candidate({
          installId: "now-installer",
          choice: "on",
          latest: { version: "1.1.0", tier: "self-deploying" },
        }),
        candidate({ installId: "tried", choice: "on", triedBefore: "failed" }),
        candidate({ installId: "rolled", choice: "on", triedBefore: "rolled-back" }),
        candidate({ installId: "waits", choice: "on", waiting: "1.1.0" }),
        candidate({ installId: "newer", choice: "on", waiting: "1.0.5" }),
      ],
      false,
    ).map((d) => [d.installId, d.action === "skip" ? d.reason : d.action]);
    expect(reasons).toEqual([
      ["default-off", "off"],
      ["own-off", "off"],
      ["busy", "not-installed"],
      ["failed", "not-installed"],
      ["unlisted", "not-in-catalog"],
      ["current", "up-to-date"],
      ["older", "up-to-date"],
      ["sandbox", "needs-approval"],
      ["now-sandbox", "needs-approval"],
      ["installer", "needs-approval"],
      ["no-installer", "reinstall-needed"],
      ["now-installer", "reinstall-needed"],
      ["tried", "failed-before"],
      ["rolled", "rolled-back"],
      ["waits", "waiting"],
      ["newer", "try"],
    ]);
  });

  it(`tries at most ${MAX_APP_ATTEMPTS_PER_RUN} per run, in order; skipped ones do not count`, () => {
    expect(MAX_APP_ATTEMPTS_PER_RUN).toBe(10);
    const decisions = planAppUpdates(
      [
        candidate({ installId: "a" }),
        candidate({ installId: "off", choice: "off" }),
        candidate({ installId: "b" }),
        candidate({ installId: "c" }),
        candidate({ installId: "d" }),
      ],
      true,
      3,
    );
    expect(
      decisions.map((d) => (d.action === "try" ? d.installId : `${d.installId}:${d.reason}`)),
    ).toEqual(["a", "off:off", "b", "c", "d:limit"]);
  });
});

describe("planUpdateAll", () => {
  it("splits the listed updates into those it starts and those that need an admin", () => {
    const decisions = planUpdateAll([
      // The automatic-update setting does not matter: an admin asked.
      candidate({ installId: "own-off", choice: "off" }),
      candidate({ installId: "waits", waiting: "1.1.0" }),
      candidate({ installId: "sandbox", buildKind: "sandbox" }),
      candidate({ installId: "now-sandbox", latest: { version: "1.1.0", tier: "sandbox" } }),
      candidate({
        installId: "installer",
        buildKind: "self-deploying",
        latest: { version: "1.1.0", tier: "self-deploying" },
      }),
      candidate({ installId: "no-installer", buildKind: "self-deploying" }),
      candidate({ installId: "tried", triedBefore: "failed" }),
      candidate({ installId: "rolled", triedBefore: "rolled-back" }),
      candidate({ installId: "busy", status: "updating" }),
      candidate({ installId: "unlisted", latest: null }),
      candidate({ installId: "current", latest: { version: "1.0.0", tier: "artifact" } }),
    ]);
    expect(decisions).toEqual([
      { installId: "own-off", action: "try", version: "1.1.0" },
      { installId: "waits", action: "try", version: "1.1.0" },
      { installId: "sandbox", action: "needs-admin", version: "1.1.0", reason: "needs-approval" },
      {
        installId: "now-sandbox",
        action: "needs-admin",
        version: "1.1.0",
        reason: "needs-approval",
      },
      { installId: "installer", action: "needs-admin", version: "1.1.0", reason: "needs-approval" },
      {
        installId: "no-installer",
        action: "needs-admin",
        version: "1.1.0",
        reason: "reinstall-needed",
      },
      { installId: "tried", action: "needs-admin", version: "1.1.0", reason: "failed-before" },
      { installId: "rolled", action: "needs-admin", version: "1.1.0", reason: "rolled-back" },
      { installId: "busy", action: "skip", reason: "not-installed" },
      { installId: "unlisted", action: "skip", reason: "not-in-catalog" },
      { installId: "current", action: "skip", reason: "up-to-date" },
    ]);
    for (const reason of [
      "reinstall-needed",
      "needs-approval",
      "failed-before",
      "rolled-back",
    ] as const) {
      expect(NEEDS_ADMIN_COPY[reason]).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("tries at most the cron's per-run number; the ones needing an admin do not count", () => {
    const decisions = planUpdateAll(
      [
        candidate({ installId: "a" }),
        candidate({ installId: "sandbox", buildKind: "sandbox" }),
        candidate({ installId: "b" }),
        candidate({ installId: "c" }),
      ],
      2,
    );
    expect(decisions.map((d) => `${d.installId}:${d.action}`)).toEqual([
      "a:try",
      "sandbox:needs-admin",
      "b:try",
      "c:skip",
    ]);
    expect(decisions.at(-1)).toEqual({ installId: "c", action: "skip", reason: "limit" });
  });

  it("judges an update by the same rules as the cron", () => {
    for (const c of [
      candidate(),
      candidate({ buildKind: "sandbox" }),
      candidate({ buildKind: "self-deploying" }),
      candidate({ triedBefore: "failed" }),
      candidate({ status: "failed" }),
    ]) {
      const block = unattendedUpdateBlock(c);
      const cron = planAppUpdates([{ ...c, choice: "on" }], false)[0];
      expect(cron?.action === "skip" ? cron.reason : null).toBe(block);
    }
  });
});

describe("planSelfUpdate", () => {
  const ready = {
    enabled: true,
    devBuild: false,
    updateAvailable: true,
    latestVersion: "0.6.0",
    failedBefore: false,
  };

  it("tries the newest release when the setting is on and it is newer", () => {
    expect(planSelfUpdate(ready)).toEqual({ action: "try", version: "0.6.0" });
  });

  it("never updates a development build, and says why it waits otherwise", () => {
    expect(planSelfUpdate({ ...ready, enabled: false })).toEqual({ action: "skip", reason: "off" });
    expect(planSelfUpdate({ ...ready, devBuild: true })).toEqual({
      action: "skip",
      reason: "dev-build",
    });
    expect(planSelfUpdate({ ...ready, latestVersion: null })).toEqual({
      action: "skip",
      reason: "no-release",
    });
    expect(planSelfUpdate({ ...ready, updateAvailable: false })).toEqual({
      action: "skip",
      reason: "up-to-date",
    });
    expect(planSelfUpdate({ ...ready, failedBefore: true })).toEqual({
      action: "skip",
      reason: "failed-before",
    });
  });
});

describe("startedByLabel", () => {
  it("names the cron's jobs apart from an admin's", () => {
    expect(startedByLabel("schedule")).toBe("Automatic");
    expect(startedByLabel("admin")).toBe("Admin");
  });
});
