import { settingsPlace } from "../components/settings-links";
import type { SetupStep as GateStep } from "../server/gate";
import type { ChecklistData } from "./checklist.server";

/**
 * The setup wizard as one page: which step it shows and how it moves on.
 * The server decides where a visit starts (`setupGate`); after that each
 * step's own call moves the wizard forward in place, so the frame, its width
 * and the step indicator never remount between steps. Pure and client-safe;
 * the transitions are tested here.
 */

/** What a token saved in the wizard reports back. */
export interface SavedTokenSummary {
  accountId: string;
  accountName: string | null;
  workerName: string;
  /** Permission groups the save could not confirm. */
  missing: string[];
  /** False when a leftover `SETUP_TOKEN` could not be deleted from the Worker. */
  setupTokenRemoved?: boolean;
}

export type WizardState =
  | { step: "connect" }
  | { step: "redeploying" }
  | { step: "create-owner" }
  | { step: "checklist"; checklist: ChecklistData }
  /** An admin whose manager has users but no token yet. */
  | { step: "cloudflare-token" }
  /** That admin's token is saved; waiting for the redeployed Worker to hold it. */
  | { step: "token-saved"; saved: SavedTokenSummary }
  | { step: "wait-for-admin" };

export type WizardEvent =
  /** The token was verified and saved; `next` is what the server said follows. */
  | { type: "connected"; next: "create-owner" | "redeploying" }
  /** A version with the auth secret serves. */
  | { type: "auth-ready" }
  /** The owner exists and is signed in; the checklist was read. */
  | { type: "owner-created"; checklist: ChecklistData }
  /** An admin saved the token outside first-run setup. */
  | { type: "token-saved"; saved: SavedTokenSummary }
  /** The checklist was read (after the token-saved wait, or re-checked). */
  | { type: "checklist-loaded"; checklist: ChecklistData }
  /** The server's view of where setup stands, after a refusal or a reload. */
  | { type: "sync"; state: WizardState };

/**
 * The state a visit starts in, from the server's gate and, for step 3, the
 * checklist the loader read with it.
 */
export function initialWizardState(step: GateStep, checklist: ChecklistData | null): WizardState {
  if (step !== "checklist") return { step };
  if (checklist === null) throw new Error("The checklist step needs the checklist data.");
  return { step, checklist };
}

/**
 * The next state. Events that do not belong to the current step leave it as
 * it is (a late poll, a double click), so the wizard never jumps back.
 */
export function wizardReducer(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case "sync":
      return event.state;
    case "connected":
      return state.step === "connect" ? { step: event.next } : state;
    case "auth-ready":
      return state.step === "redeploying" ? { step: "create-owner" } : state;
    case "owner-created":
      return state.step === "create-owner"
        ? { step: "checklist", checklist: event.checklist }
        : state;
    case "token-saved":
      return state.step === "cloudflare-token"
        ? { step: "token-saved", saved: event.saved }
        : state;
    case "checklist-loaded":
      return state.step === "token-saved" || state.step === "checklist"
        ? { step: "checklist", checklist: event.checklist }
        : state;
  }
}

export type WizardStepNumber = 1 | 2 | 3;

/**
 * The step indicator's position, or null for screens outside the three steps
 * (a member waiting for an admin, an admin adding a missing token).
 */
export function wizardStepNumber(state: WizardState): WizardStepNumber | null {
  switch (state.step) {
    case "connect":
      return 1;
    case "redeploying":
    case "create-owner":
      return 2;
    case "checklist":
      return 3;
    case "cloudflare-token":
    case "token-saved":
    case "wait-for-admin":
      return null;
  }
}

export interface WizardCopy {
  title: string;
  description: string;
}

/** Each step's title and one-line description. */
export function wizardCopy(state: WizardState): WizardCopy {
  switch (state.step) {
    case "connect":
      return {
        title: "Connect Cloudflare",
        description: "Appflare needs an API token for the Cloudflare account it runs in.",
      };
    case "redeploying":
      return {
        title: "Create the owner account",
        description:
          "Appflare is redeploying itself with its new secrets. This takes a few seconds.",
      };
    case "create-owner":
      return {
        title: "Create the owner account",
        description:
          "The owner installs apps, manages users, and is the only one who can hand ownership over.",
      };
    case "checklist":
      return {
        title: "Check your account",
        description: `What this Cloudflare account has that apps rely on. This list stays in ${settingsPlace("account", "checklist", "Your account")}, in Settings.`,
      };
    case "cloudflare-token":
      return {
        title: "Connect Cloudflare",
        description: "Appflare installs and updates apps with an API token you create.",
      };
    case "token-saved":
      return {
        title: "Cloudflare connected",
        description: `The token is saved on the Worker "${state.saved.workerName}".`,
      };
    case "wait-for-admin":
      return { title: "Set up Appflare", description: "Setup is not finished yet." };
  }
}

/** How long the verified account name stays on screen before the wizard moves on. */
export const CONNECTED_PAUSE_MS = 1500;

/** What the token step shows once its one call succeeded. */
export interface TokenOutcome {
  /** "Connected to <account>". */
  headline: string;
  /** Permission groups the save could not confirm; shown as a warning. */
  missing: string[];
  /**
   * Move on by itself after {@link CONNECTED_PAUSE_MS}. Not when something
   * could not be confirmed: the warning then waits for Continue.
   */
  autoAdvance: boolean;
}

export function tokenOutcome(
  saved: Pick<SavedTokenSummary, "accountId" | "accountName" | "missing">,
): TokenOutcome {
  const account = saved.accountName ? saved.accountName : `account ${saved.accountId}`;
  return {
    headline: `Connected to ${account}`,
    missing: saved.missing,
    autoAdvance: saved.missing.length === 0,
  };
}
