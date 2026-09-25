import type { CustomHostname } from "@appflare/cf-api";
import {
  type ExternalDomainStatus,
  externalDomainPhase,
  externalDomainProblem,
} from "./external-domain-input";

/**
 * The pure decisions of the scheduled check of external domains
 * (./external-domains-poll.server.ts): what state a domain is in from
 * Cloudflare's answer, and whether that is a change worth telling.
 *
 * A domain's recorded state is `pending` (waiting for its records or its
 * certificate), `active` (it serves the app), `failed` (it will not serve
 * until someone acts: the custom hostname is blocked or moved, or its
 * certificate timed out or expired), or `removed` (Cloudflare no longer has
 * its custom hostname, for example after it was deleted in the dashboard).
 * Going active, failing, and being removed are each told once. Once active,
 * a domain reported as pending stays active: Cloudflare can report an active
 * hostname as pending for a while as it renews or redeploys its certificate,
 * and that is no news.
 */

export const EXTERNAL_DOMAIN_STATES = ["pending", "active", "failed", "removed"] as const;
export type ExternalDomainState = (typeof EXTERNAL_DOMAIN_STATES)[number];

/** States that mean the domain does not serve until someone acts ("Domain failed"). */
const PROBLEM_STATES: ReadonlySet<ExternalDomainState> = new Set(["failed", "removed"]);

/** What is recorded per domain: its state, and since when (epoch ms). */
export interface RecordedDomainState {
  state: ExternalDomainState;
  since: number;
}

/**
 * A domain first seen active is told about only when it was added at most
 * this long ago: one added before the check existed, or while it was not
 * running, is old news.
 */
export const FRESH_DOMAIN_MS = 24 * 3_600_000;

/** What Cloudflare reports now: its custom hostname, or undefined when it has none. */
export function observedDomainState(ch: CustomHostname | undefined): {
  state: ExternalDomainState;
  /** Why a failed or removed domain does not serve (one sentence); null otherwise. */
  reason: string | null;
} {
  const status: Pick<ExternalDomainStatus, "status" | "sslStatus" | "active"> =
    ch === undefined
      ? { status: "missing", sslStatus: null, active: false }
      : {
          status: ch.status,
          sslStatus: ch.ssl?.status ?? null,
          active: ch.status === "active" && ch.ssl?.status === "active",
        };
  const tone = externalDomainPhase(status).tone;
  if (tone === "success") return { state: "active", reason: null };
  if (tone === "problem") {
    return {
      state: ch === undefined ? "removed" : "failed",
      reason: externalDomainProblem(status),
    };
  }
  return { state: "pending", reason: null };
}

export interface DomainStateChange {
  /** The state to record now; null keeps what is recorded. */
  record: RecordedDomainState | null;
  /** The event the change makes, if any. */
  event: "domain_active" | "domain_failed" | null;
  /**
   * The event's dedupe key part: when the state it leaves began (0 for a
   * domain seen for the first time), so two overlapping checks that both see
   * the change make one event.
   */
  from: number;
}

/**
 * The change from the recorded state to what Cloudflare reports now. Going
 * active is "Domain active"; failing or being removed is "Domain failed",
 * also from active (and from failed to removed, a new problem). A first
 * sight is an event only when the domain has a problem, or went active within
 * {@link FRESH_DOMAIN_MS} of being added.
 */
export function domainStateChange(
  recorded: RecordedDomainState | null,
  observed: ExternalDomainState,
  at: { now: number; addedAt: number },
): DomainStateChange {
  const from = recorded?.since ?? 0;
  const record = { state: observed, since: at.now };
  if (recorded === null) {
    const event = PROBLEM_STATES.has(observed)
      ? "domain_failed"
      : observed === "active" && at.now - at.addedAt <= FRESH_DOMAIN_MS
        ? "domain_active"
        : null;
    return { record, event, from };
  }
  if (recorded.state === observed) return { record: null, event: null, from };
  if (recorded.state === "active" && observed === "pending") {
    return { record: null, event: null, from };
  }
  const event =
    observed === "active" ? "domain_active" : PROBLEM_STATES.has(observed) ? "domain_failed" : null;
  return { record, event, from };
}

/** The recorded state as stored (a `settings` value); null when it cannot be read. */
export function parseRecordedDomainState(value: string): RecordedDomainState | null {
  try {
    const parsed = JSON.parse(value) as { state?: unknown; since?: unknown };
    const state = EXTERNAL_DOMAIN_STATES.find((s) => s === parsed.state);
    if (state !== undefined && typeof parsed.since === "number" && Number.isFinite(parsed.since)) {
      return { state, since: parsed.since };
    }
  } catch {
    // unreadable: the domain counts as seen for the first time
  }
  return null;
}

export function recordedDomainStateJson(state: RecordedDomainState): string {
  return JSON.stringify({ state: state.state, since: state.since });
}
