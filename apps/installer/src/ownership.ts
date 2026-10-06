import { LEASE_MS } from "./records";

/**
 * When a resource found by name counts as one this installation created.
 *
 * A create is recorded as attempted (its time) just before it is sent, and
 * the mark is cleared again when Cloudflare definitely refused it. Only a
 * create whose answer never arrived (a timeout, a server error) leaves the
 * mark, and then a resource of that name counts as the installation's only
 * when it was made while that request could have been running: from the
 * attempt until the request's lease ran out, with a little leeway for the
 * two clocks. Anything made outside that window was made by something else,
 * even under the same name, and is never adopted or removed.
 *
 * KV namespaces carry no creation time, so the window is applied to when the
 * namespace is found instead: it is taken as the installation's only when
 * exactly one namespace has the title and it is found soon after the
 * attempt. Later, the installation cannot tell, and refuses.
 */

/** Leeway between Cloudflare's clock and the Worker's. */
export const CLOCK_LEEWAY_MS = 30_000;

/** Whether a resource created at `createdOn` was made by the create attempted at `attemptAt`. */
export function createdByAttempt(createdOn: string | undefined, attemptAt: number | null): boolean {
  if (attemptAt === null || createdOn === undefined) return false;
  const at = Date.parse(createdOn);
  return (
    Number.isFinite(at) &&
    at >= attemptAt - CLOCK_LEEWAY_MS &&
    at <= attemptAt + LEASE_MS + CLOCK_LEEWAY_MS
  );
}

/** How long after an attempt a namespace with its title is still taken as that attempt's. */
export const KV_ATTEMPT_WINDOW_MS = 10 * 60_000;

/**
 * Whether the KV namespaces titled like the installation's are the one its
 * create attempted at `attemptAt` made: exactly one, found within the window.
 */
export function kvByAttempt(sameTitle: number, attemptAt: number | null, now: number): boolean {
  return (
    sameTitle === 1 &&
    attemptAt !== null &&
    now >= attemptAt - CLOCK_LEEWAY_MS &&
    now <= attemptAt + KV_ATTEMPT_WINDOW_MS
  );
}
