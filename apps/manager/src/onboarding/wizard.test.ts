import { describe, expect, it } from "vitest";
import { capabilitiesView } from "../capabilities/capabilities";
import { catalogNeeds } from "../capabilities/capability-rows";
import type { CapabilityRowsData } from "../capabilities/capability-rows.server";
import { NO_SANDBOX_JOBS } from "../sandbox/readiness";
import {
  initialWizardState,
  type SavedTokenSummary,
  tokenOutcome,
  type WizardEvent,
  type WizardState,
  wizardCopy,
  wizardReducer,
  wizardStepNumber,
} from "./wizard";

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
  });

  it("walks token, owner, checklist in place", () => {
    const start: WizardState = { step: "connect" };
    const owner = run(start, { type: "connected", next: "create-owner" });
    expect(owner).toEqual({ step: "create-owner" });
    expect(run(owner, { type: "owner-created", checklist: CHECKLIST })).toEqual({
      step: "checklist",
      checklist: CHECKLIST,
    });
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
    expect(run(connect, { type: "owner-created", checklist: CHECKLIST })).toBe(connect);
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

  it("keeps the step indicator on the three steps only", () => {
    expect(wizardStepNumber({ step: "connect" })).toBe(1);
    expect(wizardStepNumber({ step: "redeploying" })).toBe(2);
    expect(wizardStepNumber({ step: "create-owner" })).toBe(2);
    expect(wizardStepNumber({ step: "checklist", checklist: CHECKLIST })).toBe(3);
    expect(wizardStepNumber({ step: "wait-for-admin" })).toBeNull();
    expect(wizardStepNumber({ step: "cloudflare-token" })).toBeNull();
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
