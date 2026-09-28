import { checkAddress, checkTypedAddress } from "./address.ts";
import type { Intent, Memory } from "./memory.ts";
import { type InstallApp, type InstallRequest, installTarget } from "./request.ts";

/**
 * The steps of the install pages (`/install/<slug>/`, `/install/?repo=`)
 * and of `/my/`, where a visitor's Appflare tells this site its address.
 * A visitor whose Appflare is remembered goes straight on to it, seeing
 * where they are going; everyone else chooses, and remembering an address
 * always takes a click. The memory is passed in, so every step can be
 * tested without a browser; the pages only draw a step and pass on clicks.
 */

/** Which page the steps are on. */
export type FlowPage =
  | {
      page: "install";
      /** Null when the link names nothing that can be installed. */
      request: InstallRequest | null;
      /** For a repository link, the catalog app built from that repository. */
      catalogApp: Pick<InstallApp, "slug" | "name"> | null;
    }
  | { page: "my" };

export type FlowView =
  /** Before the page runs in the browser: nothing is known yet. */
  | { step: "loading" }
  /** The link names nothing, or an address that is not one. */
  | { step: "invalid" }
  /** A repository link for an app the catalog has: offer the catalog's first. */
  | { step: "in-catalog"; app: Pick<InstallApp, "slug" | "name"> }
  /** No Appflare remembered: "Do you have Appflare?" */
  | { step: "ask" }
  | { step: "enter"; value: string; error: string | null }
  /** "Remember <origin> as your Appflare?"; `replaces` is the one remembered now. */
  | { step: "remember"; origin: string; replaces: string | null }
  /** How to get Appflare; `intentSaved` when the app waits here for 7 days. */
  | { step: "get"; intentSaved: boolean }
  /** On the way to the visitor's Appflare, after a short pause. */
  | { step: "opening"; origin: string; target: string; remembered: boolean }
  /** `/my/`: the Appflare this browser remembers. */
  | { step: "saved"; origin: string; intent: Intent | null; justRemembered: boolean }
  /** `/my/`: none remembered. */
  | { step: "none"; forgotten: boolean }
  /** `/my/`: an address this browser will not let the site keep. */
  | { step: "cannot-remember"; origin: string };

export interface FlowState {
  context: FlowPage;
  /** Whether this browser lets the site remember anything. */
  canRemember: boolean;
  view: FlowView;
}

export type FlowAction =
  | { type: "choose-enter" }
  | { type: "choose-get" }
  | { type: "edit"; value: string }
  | { type: "submit" }
  | { type: "remember" }
  /** Open the Appflare without remembering it. */
  | { type: "once" }
  | { type: "back" }
  /** Stop, and enter another address. */
  | { type: "change" }
  /** Build from the repository rather than install the catalog's app. */
  | { type: "use-repository" }
  | { type: "forget" };

/** How long a remembered visitor sees where they are going before they go. */
export const FORWARD_DELAY_MS = 1500;

/** The state a page shows before it runs in the browser. */
export function loadingState(context: FlowPage): FlowState {
  return { context, canRemember: false, view: { step: "loading" } };
}

function state(context: FlowPage, memory: Memory, view: FlowView): FlowState {
  return { context, canRemember: memory.available, view };
}

/** On the way to `origin`; a saved intent for the same app is done with. */
function opening(
  context: FlowPage,
  memory: Memory,
  origin: string,
  remembered: boolean,
): FlowState {
  if (context.page !== "install" || context.request === null) {
    return state(context, memory, { step: "invalid" });
  }
  const target = installTarget(origin, context.request);
  if (target === null) return state(context, memory, { step: "invalid" });
  memory.clearIntentFor(context.request);
  return state(context, memory, { step: "opening", origin, target, remembered });
}

/** An install page past the catalog question: forward, or ask. */
function proceed(context: FlowPage, memory: Memory): FlowState {
  const origin = memory.manager();
  if (origin !== null) return opening(context, memory, origin, true);
  return state(context, memory, { step: "ask" });
}

/** `/my/` as it is without a link: the remembered Appflare, or none. */
function myHome(memory: Memory, now: Date, forgotten = false): FlowState {
  const context: FlowPage = { page: "my" };
  const origin = memory.manager();
  if (origin === null) return state(context, memory, { step: "none", forgotten });
  return state(context, memory, {
    step: "saved",
    origin,
    intent: memory.intent(now),
    justRemembered: false,
  });
}

/** An install page as the visitor arrives. */
export function startInstall(
  request: InstallRequest | null,
  catalogApp: Pick<InstallApp, "slug" | "name"> | null,
  memory: Memory,
): FlowState {
  const context: FlowPage = { page: "install", request, catalogApp };
  if (request === null) return state(context, memory, { step: "invalid" });
  if (request.kind === "repo" && catalogApp !== null) {
    return state(context, memory, { step: "in-catalog", app: catalogApp });
  }
  return proceed(context, memory);
}

/**
 * The address a `/my/` link carries in its fragment (`#manager=<origin>`),
 * null when there is none, or "invalid" when there is one and it is not an
 * address. A fragment rather than a query, because browsers never send it
 * to a server.
 */
export function managerFromFragment(hash: string): string | null | "invalid" {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const values = params.getAll("manager");
  if (values.length === 0) return null;
  const [value] = values;
  if (values.length > 1 || value === undefined) return "invalid";
  const check = checkAddress(value);
  return check.ok ? check.origin : "invalid";
}

/** `/my/` as the visitor arrives, with the page's fragment. Nothing is stored yet. */
export function startMy(hash: string, memory: Memory, now: Date): FlowState {
  const context: FlowPage = { page: "my" };
  const offered = managerFromFragment(hash);
  if (offered === null) return myHome(memory, now);
  if (offered === "invalid") return state(context, memory, { step: "invalid" });
  if (!memory.available)
    return state(context, memory, { step: "cannot-remember", origin: offered });
  const current = memory.manager();
  if (current === offered) return myHome(memory, now);
  return state(context, memory, { step: "remember", origin: offered, replaces: current });
}

/** The next state after a click; an action a step does not offer changes nothing. */
export function reduce(
  current: FlowState,
  action: FlowAction,
  memory: Memory,
  now: Date,
): FlowState {
  const { context, view } = current;
  const next = (v: FlowView) => state(context, memory, v);
  const install = context.page === "install" ? context : null;

  switch (action.type) {
    case "choose-enter":
      if (view.step === "ask" || view.step === "none" || view.step === "get") {
        return next({ step: "enter", value: "", error: null });
      }
      return current;

    case "choose-get":
      if (view.step !== "ask" || install === null || install.request === null) return current;
      return next({ step: "get", intentSaved: memory.saveIntent(install.request, now) });

    case "edit":
      if (view.step !== "enter") return current;
      return next({ step: "enter", value: action.value, error: null });

    case "submit": {
      if (view.step !== "enter") return current;
      const check = checkTypedAddress(view.value);
      if (!check.ok) return next({ ...view, error: check.error });
      const remembered = memory.manager();
      if (install !== null) {
        if (!memory.available) return opening(context, memory, check.origin, false);
        if (remembered === check.origin) return opening(context, memory, check.origin, true);
      } else {
        if (!memory.available) return next({ step: "cannot-remember", origin: check.origin });
        if (remembered === check.origin) return myHome(memory, now);
      }
      return next({ step: "remember", origin: check.origin, replaces: remembered });
    }

    case "remember": {
      if (view.step !== "remember") return current;
      const kept = memory.rememberManager(view.origin);
      if (install !== null) return opening(context, memory, view.origin, kept);
      if (!kept) return next({ step: "cannot-remember", origin: view.origin });
      return next({
        step: "saved",
        origin: view.origin,
        intent: memory.intent(now),
        justRemembered: true,
      });
    }

    case "once":
      if (view.step !== "remember" || install === null) return current;
      return opening(context, memory, view.origin, false);

    case "back":
      if (install !== null) {
        if (view.step === "remember")
          return next({ step: "enter", value: view.origin, error: null });
        if (view.step === "enter" || view.step === "get") return next({ step: "ask" });
        return current;
      }
      // On `/my/`, going back from a question drops it: nothing is stored.
      if (view.step === "remember" || view.step === "enter" || view.step === "cannot-remember") {
        return myHome(memory, now);
      }
      return current;

    case "change":
      if (view.step === "opening" || view.step === "saved") {
        return next({ step: "enter", value: view.origin, error: null });
      }
      return current;

    case "use-repository":
      if (view.step !== "in-catalog") return current;
      return proceed(context, memory);

    case "forget":
      if (view.step !== "saved") return current;
      memory.forgetManager();
      return myHome(memory, now, true);
  }
}
