import type { CallbackView } from "../deploy/callback.ts";
import { type DeployView, NO_ACCOUNT_ERROR, STORAGE_REFUSED_ERROR } from "../deploy/flow.ts";
import type { CountedAttempt, Slot } from "../deploy/storage.ts";
import { isReportingHost, POSTHOG_HOST, POSTHOG_KEY, type SiteEvents } from "./analytics.ts";

/**
 * How far installs from the deploy page get: the one event the deploy page
 * and its callback send, {@link SiteEvents.deploy_step}.
 *
 * Those pages hold the visitor's Cloudflare tokens, so they never load
 * PostHog's library: it records whatever the page shows and does (clicks,
 * recordings, the address), keeps its own id for the visitor, and loads more
 * scripts from PostHog, which the pages' Content-Security-Policy refuses.
 * Instead, each step is one small request this module writes itself, to
 * PostHog's capture endpoint (`connect-src` allows any https address, for
 * the new Appflare's), and it carries exactly this:
 *
 * - the event's name and the step; for an error, its kind from a fixed list
 *   (see {@link deployStepOf}), never a message, which can name an address;
 * - `distinct_id`: a random id made in this tab for one attempt and kept in
 *   sessionStorage across the trip to Cloudflare. Trying again after an error
 *   keeps it; only an install after a deployed one gets a new one (see
 *   {@link stepCounter}). It is not the id PostHog gives the visitor on the
 *   site's other pages, so the steps cannot be joined to the rest of their
 *   visit;
 * - `$process_person_profile: false`, so PostHog makes no profile of it;
 *   `$ip` set to {@link NO_IP}, which takes the place of the address PostHog
 *   would otherwise store from the request; and `$geoip_disable`, so PostHog
 *   looks up no location.
 *
 * No account, name, address, token, page address, referrer or cookie. Only
 * the public address sends anything; a local server or a preview does not.
 */

/** PostHog's endpoint for one event. */
export const CAPTURE_URL = `${POSTHOG_HOST}/i/v0/e/`;

/** What the event stores in place of the visitor's IP address. */
export const NO_IP = "0.0.0.0";

export type StepEvent = SiteEvents["deploy_step"];

/** An installer step's id (`release`, `workers-dev`): lowercase words, never an address or an id. */
const INSTALLER_STEP = /^[a-z][a-z-]{0,23}$/;

function failed(kind: string): StepEvent {
  return { step: "error", error_kind: kind };
}

/**
 * The step a view of the deploy page is, or null for one that is not (the
 * page starting, a wait between steps, removing an unfinished install).
 * Error kinds: `unavailable` (the page cannot sign in from this address),
 * `storage-refused`, `connect` (Connect Cloudflare failed), `reconnect` (the
 * connection ran out), `accounts` (they could not be read), `no-account`,
 * `stopped`, `deploy-failed` with the installer's step (`deploy-failed:worker`),
 * `handoff-<problem>` (Appflare did not take the connection) and
 * `not-answering` (Appflare's address did not answer in time).
 */
export function deployStepOf(view: DeployView): StepEvent | null {
  switch (view.step) {
    case "loading":
    case "working":
    case "handing-off":
    case "confirm-remove":
    case "removing":
    case "removed":
      return null;
    case "unavailable":
      return failed("unavailable");
    case "welcome":
      if (view.busy) return { step: "consent" };
      if (view.error !== null) {
        return failed(view.error === STORAGE_REFUSED_ERROR ? "storage-refused" : "connect");
      }
      return view.notice === "reconnect" ? failed("reconnect") : { step: "intro" };
    case "account":
    case "unfinished":
    case "name":
    case "address":
    case "review":
      return { step: "account" };
    case "deploying":
      return { step: "deploying" };
    case "deploy-failed": {
      const id = view.progress?.step.id;
      return failed(
        id !== undefined && INSTALLER_STEP.test(id) ? `deploy-failed:${id}` : "deploy-failed",
      );
    }
    case "handoff-failed":
      return failed(`handoff-${view.problem}`);
    case "opening":
      return view.answering === "not-yet" ? failed("not-answering") : { step: "deployed" };
    case "set-up":
      return { step: "deployed" };
    case "error":
      if (view.retry === "accounts") return failed("accounts");
      return failed(view.message === NO_ACCOUNT_ERROR ? "no-account" : "stopped");
  }
}

/**
 * The step the callback page ends at, for a sign-in the deploy page started:
 * `declined` at Cloudflare, `callback-unknown-session` (the tab that started
 * it is not this one: another tab, or another browser, as when an app's own
 * browser hands the page to the real one halfway), and `callback-<kind>`
 * when the code did not become a usable connection. Null for the rest,
 * which includes everything about a manager's Reconnect Cloudflare.
 */
export function callbackStepOf(view: CallbackView): StepEvent | null {
  if (view.step === "declined") return failed("declined");
  if (view.step !== "problem") return null;
  const { problem } = view;
  if (typeof problem !== "string") return failed(`callback-${problem.kind}`);
  return problem === "unknown-session" ? failed("callback-unknown-session") : null;
}

/** The request body for one step of the attempt `attemptId`. */
export function captureBody(event: StepEvent, attemptId: string): string {
  return JSON.stringify({
    api_key: POSTHOG_KEY,
    event: "deploy_step",
    distinct_id: attemptId,
    properties: {
      step: event.step,
      ...(event.error_kind === undefined ? {} : { error_kind: event.error_kind }),
      $process_person_profile: false,
      $ip: NO_IP,
      $geoip_disable: true,
    },
  });
}

export interface StepCounterDeps {
  /** Where this tab keeps the attempt. */
  slot: Slot<CountedAttempt>;
  /** Sends one request body. */
  send: (body: string) => void;
  newId: () => string;
}

/**
 * Counts each step once per attempt (an error once per kind), so a reload
 * or a step drawn again does not count twice. Once an attempt is deployed,
 * the next first screen this tab shows starts a new one. Where the tab
 * keeps nothing, the attempt lasts as long as the page.
 */
export function stepCounter(deps: StepCounterDeps): (event: StepEvent | null) => void {
  let unkept: CountedAttempt | null = null;
  const fresh = (): CountedAttempt => ({ id: deps.newId(), sent: [] });
  return (event) => {
    if (event === null) return;
    let attempt = deps.slot.read() ?? unkept ?? fresh();
    if (event.step === "intro" && attempt.sent.includes("deployed")) attempt = fresh();
    const key = event.step === "error" ? `error:${event.error_kind ?? ""}` : event.step;
    if (attempt.sent.includes(key)) return;
    deps.send(captureBody(event, attempt.id));
    const next = { id: attempt.id, sent: [...attempt.sent, key].slice(-32) };
    unkept = deps.slot.write(next) ? null : next;
  };
}

/**
 * One request, without cookies or a referrer, that outlives the page when
 * the page moves on at once (to Cloudflare, or to the new Appflare). Plain
 * text, so the browser sends it without asking PostHog first. A browser
 * that cannot keep a request alive (Firefox before 133) may lose a step
 * the page leaves at once; `sendBeacon` would keep it, but sends cookies.
 */
function send(body: string): void {
  try {
    void fetch(CAPTURE_URL, {
      method: "POST",
      body,
      headers: { "Content-Type": "text/plain" },
      keepalive: true,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).catch(() => {});
  } catch {
    // Counting never gets in the way of installing.
  }
}

/** The counter for this page: counts on the public address only. */
export function browserStepCounter(slot: Slot<CountedAttempt>): (event: StepEvent | null) => void {
  if (typeof window === "undefined" || !isReportingHost(window.location.hostname)) return () => {};
  return stepCounter({ slot, send, newId: () => crypto.randomUUID() });
}
