import { describe, expect, it } from "vitest";
import { capabilitiesView } from "../capabilities/capabilities";
import { catalogNeeds } from "../capabilities/capability-rows";
import type { CapabilityRowsData } from "../capabilities/capability-rows.server";
import { safeReturnPath } from "../components/internal-path";
import type { AddressOptions } from "../domains/manager-address.server";
import { NO_SANDBOX_JOBS } from "../sandbox/readiness";
import {
  ADDRESS_UNREADABLE_NOTE,
  initialWizardState,
  type SavedTokenSummary,
  setupResumePath,
  tokenOutcome,
  type WizardEvent,
  type WizardState,
  wizardCopy,
  wizardProgress,
  wizardReducer,
} from "./wizard";

const ZONES: AddressOptions = {
  zones: [{ id: "z1", name: "example.com", suggestedHostname: "appflare.example.com" }],
  inactiveZones: [],
  missing: [],
  noZones: false,
};
const NO_ZONES: AddressOptions = { zones: [], inactiveZones: [], missing: [], noZones: true };

const CHECKLIST: CapabilityRowsData = {
  view: capabilitiesView(undefined, null, "acc0000000000000000000000000000a"),
  sandbox: "off",
  needs: null,
  inUse: catalogNeeds([]),
  sandboxJobs: NO_SANDBOX_JOBS,
};
const LATER: CapabilityRowsData = { ...CHECKLIST, sandbox: "enabled" };

const SAVED: SavedTokenSummary = {
  accountId: "acc0000000000000000000000000000a",
  accountName: "Appflare Dev",
  workerName: "appflare",
  missing: [],
};

function run(start: WizardState, ...events: WizardEvent[]): WizardState {
  return events.reduce(wizardReducer, start);
}

describe("the setup wizard", () => {
  it("starts where the server says, with what the account can run for the last step", () => {
    expect(initialWizardState("connect", null)).toEqual({ step: "connect" });
    expect(initialWizardState("create-owner", null)).toEqual({ step: "create-owner" });
    expect(initialWizardState("checklist", CHECKLIST)).toEqual({
      step: "checklist",
      checklist: CHECKLIST,
    });
    expect(() => initialWizardState("checklist", null)).toThrow();
    // Resumed after the address step (a reload, or at Appflare's new address).
    expect(initialWizardState("checklist", CHECKLIST, { addressShown: true })).toEqual({
      step: "checklist",
      checklist: CHECKLIST,
      addressShown: true,
    });
  });

  it("walks token, owner, checklist in place when the account has no domain", () => {
    const start: WizardState = { step: "connect" };
    const owner = run(start, { type: "connected", next: "create-owner" });
    expect(owner).toEqual({ step: "create-owner" });
    for (const address of [NO_ZONES, { ...NO_ZONES, noZones: false, inactiveZones: ["x.dev"] }]) {
      expect(run(owner, { type: "owner-created", checklist: CHECKLIST, address })).toEqual({
        step: "checklist",
        checklist: CHECKLIST,
      });
    }
  });

  it("skips the address step when the domains could not be read, and says so on the last step", () => {
    const last = run(
      { step: "create-owner" },
      { type: "owner-created", checklist: CHECKLIST, address: null },
    );
    expect(last).toEqual({ step: "checklist", checklist: CHECKLIST, addressUnreadable: true });
    expect(wizardProgress(last)).toEqual({ step: 3, count: 3 });
    // Check again keeps the line.
    expect(run(last, { type: "checklist-loaded", checklist: LATER })).toEqual({
      step: "checklist",
      checklist: LATER,
      addressUnreadable: true,
    });
    expect(ADDRESS_UNREADABLE_NOTE).toBe(
      "Could not read your domains; you can set Appflare's address later in [Domains settings](/settings/domains#address).",
    );
  });

  it("asks where Appflare should live between the owner and the checklist when there is a domain", () => {
    const address = run(
      { step: "create-owner" },
      { type: "owner-created", checklist: CHECKLIST, address: ZONES },
    );
    expect(address).toEqual({ step: "address", options: ZONES, checklist: CHECKLIST });
    expect(wizardCopy(address).title).toBe("Where should Appflare live?");
    // Keep, Later, or a move that has not left the page: on to the checklist.
    expect(run(address, { type: "address-done" })).toEqual({
      step: "checklist",
      checklist: CHECKLIST,
      addressShown: true,
    });
    expect(run({ step: "create-owner" }, { type: "address-done" })).toEqual({
      step: "create-owner",
    });
  });

  it("on a manager installed from the browser, points to the installer or lets a token in", () => {
    const handoff = initialWizardState("handoff", null, {
      handoff: "waiting",
      installPage: "https://appflare.dev/deploy",
    });
    expect(handoff).toEqual({
      step: "handoff",
      received: false,
      installPage: "https://appflare.dev/deploy",
    });
    expect(wizardProgress(handoff)).toEqual({ step: 1, count: 3 });
    expect(wizardCopy(handoff).title).toBe("Finish where you installed Appflare");
    const received = initialWizardState("handoff", null, { handoff: "received" });
    expect(received).toEqual({ step: "handoff", received: true, installPage: null });
    expect(wizardCopy(received).description).toContain("to create your owner account");
    expect(wizardCopy(handoff).description).toContain("It connects Appflare");
    // Connect with an API token instead.
    expect(run(handoff, { type: "use-token" })).toEqual({ step: "connect" });
    expect(run({ step: "create-owner" }, { type: "use-token" })).toEqual({ step: "create-owner" });
  });

  it("skips the address step when Appflare already lives on a domain of the account", () => {
    const last = run(
      { step: "create-owner" },
      { type: "owner-created", checklist: CHECKLIST, address: "set" },
    );
    expect(last).toEqual({ step: "checklist", checklist: CHECKLIST });
    expect(wizardProgress(last)).toEqual({ step: 3, count: 3 });
  });

  it("waits for the redeploy when connecting wrote a new auth secret", () => {
    const waiting = run({ step: "connect" }, { type: "connected", next: "redeploying" });
    expect(waiting).toEqual({ step: "redeploying" });
    expect(run(waiting, { type: "auth-ready" })).toEqual({ step: "create-owner" });
  });

  it("ignores events that do not belong to the step it is on", () => {
    const owner: WizardState = { step: "create-owner" };
    // A late redeploy poll, a second Continue: no jump back or forward.
    expect(run(owner, { type: "auth-ready" })).toBe(owner);
    expect(run(owner, { type: "connected", next: "redeploying" })).toBe(owner);
    expect(run(owner, { type: "checklist-loaded", checklist: CHECKLIST })).toBe(owner);
    const connect: WizardState = { step: "connect" };
    expect(run(connect, { type: "owner-created", checklist: CHECKLIST, address: ZONES })).toBe(
      connect,
    );
    expect(run(connect, { type: "token-saved", saved: SAVED })).toBe(connect);
  });

  it("replaces what the account can run in place on Check again", () => {
    const shown = run(
      { step: "checklist", checklist: CHECKLIST },
      {
        type: "checklist-loaded",
        checklist: LATER,
      },
    );
    expect(shown).toEqual({ step: "checklist", checklist: LATER });
  });

  it("takes an admin without a token through the save and the redeploy wait to the checklist", () => {
    const saved = run({ step: "cloudflare-token" }, { type: "token-saved", saved: SAVED });
    expect(saved).toEqual({ step: "token-saved", saved: SAVED });
    expect(run(saved, { type: "checklist-loaded", checklist: CHECKLIST })).toEqual({
      step: "checklist",
      checklist: CHECKLIST,
    });
  });

  it("follows the server after a refusal", () => {
    expect(run({ step: "create-owner" }, { type: "sync", state: { step: "connect" } })).toEqual({
      step: "connect",
    });
  });

  it("keeps the step indicator on the steps, counting the address step only when shown", () => {
    expect(wizardProgress({ step: "connect" })).toEqual({ step: 1, count: 3 });
    expect(wizardProgress({ step: "redeploying" })).toEqual({ step: 2, count: 3 });
    expect(wizardProgress({ step: "create-owner" })).toEqual({ step: 2, count: 3 });
    expect(wizardProgress({ step: "checklist", checklist: CHECKLIST })).toEqual({
      step: 3,
      count: 3,
    });
    expect(wizardProgress({ step: "address", options: ZONES, checklist: CHECKLIST })).toEqual({
      step: 3,
      count: 4,
    });
    expect(wizardProgress({ step: "checklist", checklist: CHECKLIST, addressShown: true })).toEqual(
      { step: 4, count: 4 },
    );
    expect(wizardProgress({ step: "wait-for-admin" })).toBeNull();
    expect(wizardProgress({ step: "cloudflare-token" })).toBeNull();
  });

  it("resumes at the last step after signing in at the new address", () => {
    expect(setupResumePath(undefined)).toBe("/setup?checklist=true&address=true");
    const kept = setupResumePath("/apps/a1#secrets");
    expect(kept).toBe("/setup?checklist=true&address=true&returnTo=%2Fapps%2Fa1%23secrets");
    // Sign-in takes it as a page to return to, and drops a hostile one inside.
    for (const path of [kept, setupResumePath(undefined)]) expect(safeReturnPath(path)).toBe(path);
    expect(setupResumePath("//evil.example")).toBe("/setup?checklist=true&address=true");
  });

  it("keeps the four-step count when Check again reloads the last step", () => {
    expect(
      run(
        { step: "checklist", checklist: CHECKLIST, addressShown: true },
        { type: "checklist-loaded", checklist: LATER },
      ),
    ).toEqual({ step: "checklist", checklist: LATER, addressShown: true });
  });

  it("titles the redeploy wait as the owner step it belongs to", () => {
    expect(wizardCopy({ step: "redeploying" }).title).toBe(
      wizardCopy({ step: "create-owner" }).title,
    );
    expect(wizardCopy({ step: "connect" }).title).toBe("Connect Cloudflare");
  });

  it("points the last step at the same list on Your account", () => {
    expect(wizardCopy({ step: "checklist", checklist: CHECKLIST }).description).toContain(
      "[Your account settings](/settings/account#capabilities)",
    );
  });
});

describe("tokenOutcome", () => {
  it("names the verified account and moves on by itself", () => {
    expect(tokenOutcome(SAVED)).toEqual({
      headline: "Connected to Appflare Dev",
      missing: [],
      autoAdvance: true,
    });
  });

  it("falls back to the account id when the name is unreadable", () => {
    expect(tokenOutcome({ ...SAVED, accountName: null }).headline).toBe(
      `Connected to account ${SAVED.accountId}`,
    );
  });

  it("waits for Continue when some permission could not be confirmed", () => {
    expect(tokenOutcome({ ...SAVED, missing: ["D1: Edit"] })).toEqual({
      headline: "Connected to Appflare Dev",
      missing: ["D1: Edit"],
      autoAdvance: false,
    });
  });
});
