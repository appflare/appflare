import type { CapabilityRowsData } from "../capabilities/capability-rows.server";
import { returnToSearch } from "../components/return-to";
import { settingsPlace } from "../components/settings-links";
import type { AddressOptions } from "../domains/manager-address.server";
import type { SetupStep as GateStep } from "../server/gate";

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
  /**
   * A manager installed from the browser, in a browser without the setup
   * claim: finish from the page that installed it, or paste a token
   * instead. `received`: that page has handed over the connection already.
   * `installPage`: where that page is, when known.
   */
  | { step: "handoff"; received: boolean; installPage: string | null }
  | { step: "redeploying" }
  | { step: "create-owner" }
  /**
   * Where Appflare should live, shown only when the account has an active
   * zone; what the account can run is read already and waits.
   */
  | { step: "address"; options: AddressOptions; checklist: CapabilityRowsData }
  /**
   * `addressShown`: the address step came before, so setup has four steps.
   * `addressUnreadable`: it was skipped because the domains could not be
   * read, which the step says in one line ({@link ADDRESS_UNREADABLE_NOTE}).
   */
  | {
      step: "checklist";
      checklist: CapabilityRowsData;
      addressShown?: boolean;
      addressUnreadable?: boolean;
    }
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
  /** On the handoff screen: connect with an API token instead. */
  | { type: "use-token" }
  /**
   * The owner exists and is signed in; what the account can run was read,
   * and the zones Appflare could move to (null when they could not be read;
   * `set` when Appflare already lives on a domain of the account, which it
   * does when it was installed there).
   */
  | {
      type: "owner-created";
      checklist: CapabilityRowsData;
      address: AddressOptions | null | "set";
    }
  /** The address step is done: Appflare stays where it is, now or for later. */
  | { type: "address-done" }
  /** An admin saved the token outside first-run setup. */
  | { type: "token-saved"; saved: SavedTokenSummary }
  /** What the account can run was read (after the token-saved wait, or checked again). */
  | { type: "checklist-loaded"; checklist: CapabilityRowsData }
  /** The server's view of where setup stands, after a refusal or a reload. */
  | { type: "sync"; state: WizardState };

/**
 * The state a visit starts in, from the server's gate and, for the last
 * step, what the account can run, as the loader read it with the gate.
 * `addressShown` says the address step came before the last one (the page
 * reloaded, or the wizard resumed at Appflare's new address).
 */
export function initialWizardState(
  step: GateStep,
  checklist: CapabilityRowsData | null,
  {
    addressShown = false,
    handoff,
    installPage,
  }: {
    addressShown?: boolean;
    handoff?: "waiting" | "received" | undefined;
    installPage?: string | undefined;
  } = {},
): WizardState {
  if (step === "handoff") {
    return { step, received: handoff === "received", installPage: installPage ?? null };
  }
  if (step !== "checklist") return { step };
  if (checklist === null) throw new Error("The last setup step needs what the account can run.");
  return addressShown ? { step, checklist, addressShown } : { step, checklist };
}

/**
 * Setup's last step as the page to return to after signing in at
 * Appflare's new address (`?address=true`: the address step was shown),
 * carrying the page this visit should end on.
 */
export function setupResumePath(returnTo: string | undefined): string {
  const params = new URLSearchParams({
    checklist: "true",
    address: "true",
    ...returnToSearch(returnTo),
  });
  return `/setup?${params.toString()}`;
}

/** The last step's line when the address step was skipped because the domains could not be read. */
export const ADDRESS_UNREADABLE_NOTE = `Could not read your domains; you can set Appflare's address later in ${settingsPlace("domains", "address", "Domains settings")}.`;

/**
 * Whether setup asks where Appflare should live: only when the account has
 * an active zone to move to.
 */
export function offersAddressStep(options: AddressOptions | null): options is AddressOptions {
  return options !== null && options.zones.length > 0;
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
    case "use-token":
      return state.step === "handoff" ? { step: "connect" } : state;
    case "owner-created":
      if (state.step !== "create-owner") return state;
      if (event.address === "set") return { step: "checklist", checklist: event.checklist };
      if (offersAddressStep(event.address)) {
        return { step: "address", options: event.address, checklist: event.checklist };
      }
      return event.address === null
        ? { step: "checklist", checklist: event.checklist, addressUnreadable: true }
        : { step: "checklist", checklist: event.checklist };
    case "address-done":
      return state.step === "address"
        ? { step: "checklist", checklist: state.checklist, addressShown: true }
        : state;
    case "token-saved":
      return state.step === "cloudflare-token"
        ? { step: "token-saved", saved: event.saved }
        : state;
    case "checklist-loaded":
      if (state.step === "checklist") return { ...state, checklist: event.checklist };
      return state.step === "token-saved"
        ? { step: "checklist", checklist: event.checklist }
        : state;
  }
}

/** The step indicator: this screen's step, and how many steps this run of setup has. */
export interface WizardProgress {
  step: 1 | 2 | 3 | 4;
  count: 3 | 4;
}

/**
 * The step indicator's position, or null for screens outside the steps (a
 * member waiting for an admin, an admin adding a missing token). Setup has
 * three steps, and four once the address step is shown: it counts only
 * when the account has a domain, which is known once the owner exists.
 */
export function wizardProgress(state: WizardState): WizardProgress | null {
  switch (state.step) {
    case "connect":
    case "handoff":
      return { step: 1, count: 3 };
    case "redeploying":
    case "create-owner":
      return { step: 2, count: 3 };
    case "address":
      return { step: 3, count: 4 };
    case "checklist":
      return state.addressShown === true ? { step: 4, count: 4 } : { step: 3, count: 3 };
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
    case "handoff":
      return state.received
        ? {
            title: "Finish where you installed Appflare",
            description:
              "Appflare is connected to Cloudflare. Go back to the page that installed it and open Appflare from there to create your owner account.",
          }
        : {
            title: "Finish where you installed Appflare",
            description:
              "Appflare is installed and waiting to be connected to Cloudflare. Go back to the page that installed it: it connects Appflare and brings you here to create your owner account.",
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
    case "address":
      return {
        title: "Where should Appflare live?",
        description: `Appflare answers at its workers.dev address. It can live on a domain of yours instead, now or later in ${settingsPlace("domains", "address", "Domains settings")}.`,
      };
    case "checklist":
      return {
        title: "Check your account",
        description: `What this Cloudflare account has that apps rely on. The same list stays in ${settingsPlace("account", "capabilities", "Your account settings")}.`,
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
