/**
 * A page left open at the workers.dev address while Appflare waits to move
 * to its domain: it asks every {@link ADDRESS_WATCH_MS} whether the move
 * happened (one cheap read, `getAddressStatus`), and once it has, says so
 * and goes to the same page at the new address, unless a form there has
 * unsaved input. It asks nothing at any other address, and stops once
 * nothing is pending. Client-safe; the decisions are tested here.
 */

/** How often an open page asks. */
export const ADDRESS_WATCH_MS = 15_000;

export interface AddressStatus {
  /** The custom domain Appflare lives on; null while it lives at workers.dev. */
  hostname: string | null;
  /** A domain is pending: Appflare moves there by itself once it serves. */
  pending: boolean;
}

export type WatchStep =
  /** Ask again in a while. */
  | { kind: "wait" }
  /** Nothing is pending and Appflare lives here: stop asking. */
  | { kind: "stop" }
  /** Appflare lives at `hostname` now. */
  | { kind: "moved"; hostname: string };

/** Whether a page at `host` watches at all: only at a workers.dev address. */
export function watchesAddress(host: string): boolean {
  return host.toLowerCase().endsWith(".workers.dev");
}

/** What the page does after an answer, at `host`. */
export function watchStep(status: AddressStatus, host: string): WatchStep {
  if (status.hostname !== null && status.hostname.toLowerCase() !== host.toLowerCase()) {
    return { kind: "moved", hostname: status.hostname };
  }
  return status.pending ? { kind: "wait" } : { kind: "stop" };
}

/** The same page at the new address. */
export function movedUrl(
  hostname: string,
  location: Pick<Location, "pathname" | "search" | "hash">,
): string {
  return `https://${hostname}${location.pathname}${location.search}${location.hash}`;
}

/** The line the page shows once Appflare moved. */
export function movedLine(hostname: string): string {
  return `Appflare moved to ${hostname}.`;
}
