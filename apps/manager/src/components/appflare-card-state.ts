import type { ManagerStatus } from "../installs/pending-updates";

/**
 * What the sidebar's Appflare card shows, from Appflare's version, the
 * self-update it follows (if any) and whether the new version answers yet.
 * Pure and client-safe; the card (./appflare-card.tsx) renders it.
 */

/** The parts of a self-update job the card reads. */
export interface CardJob {
  status: "queued" | "running" | "succeeded" | "failed";
  targetVersion: string | null;
  error: string | null;
  /** The newest log line, as progress; null before the first. */
  lastStep: string | null;
}

export type AppflareCardState =
  /** Up to date (or nothing known yet): no card; the sidebar footer shows the version. */
  | { kind: "current"; version: string }
  /** Just updated to this version (this page loaded after the switch). */
  | { kind: "updated"; version: string }
  /** A newer release; `canUpdate` for admins. */
  | { kind: "available"; current: string; latest: string; canUpdate: boolean }
  /** The self-update runs; `step` is its newest log line. */
  | { kind: "running"; target: string; step: string | null }
  /** The job finished; waiting for the new version to answer, then the page reloads. */
  | { kind: "switching"; target: string }
  /** The job finished long enough ago, and the new version still did not answer here. */
  | { kind: "stalled"; target: string }
  /** The self-update failed; the current version keeps serving. */
  | {
      kind: "failed";
      target: string;
      error: string | null;
      /** The newest release, offered again to admins while it is newer; else null. */
      retry: string | null;
    };

export interface AppflareCardInput {
  manager: ManagerStatus;
  /** The self-update being followed: undefined while it is read, null when there is none. */
  job: CardJob | null | undefined;
  /** An older version still answers after the job finished. */
  switching: boolean;
  /** The wait for the new version to answer ended without it answering. */
  stalled?: boolean;
  /** The version the previous page saw the switch to, if this page loaded right after it. */
  updatedTo: string | null;
  /**
   * The "updated" card was dismissed, or has been shown long enough (the new
   * version answered a health check, or 30 seconds passed): no card again.
   */
  updatedDone?: boolean;
  isAdmin: boolean;
}

export function appflareCardState(input: AppflareCardInput): AppflareCardState {
  const state = cardState(input);
  return state.kind === "updated" && input.updatedDone === true
    ? { kind: "current", version: state.version }
    : state;
}

function cardState(input: AppflareCardInput): AppflareCardState {
  const { manager, job, isAdmin } = input;
  const target = job?.targetVersion ?? manager.latest ?? manager.current;
  if (job === undefined) return { kind: "running", target, step: null };
  if (job !== null) {
    if (job.status === "queued" || job.status === "running") {
      return input.switching
        ? { kind: "switching", target }
        : { kind: "running", target, step: job.lastStep };
    }
    if (job.status === "succeeded") {
      // Nothing but the switch is left; once the new version answers the page reloads.
      if (manager.current !== target) {
        return input.stalled === true ? { kind: "stalled", target } : { kind: "switching", target };
      }
      return { kind: "updated", version: manager.current };
    }
    return {
      kind: "failed",
      target,
      error: job.error,
      retry: isAdmin && manager.updateAvailable ? manager.latest : null,
    };
  }
  if (input.updatedTo !== null && input.updatedTo === manager.current) {
    return { kind: "updated", version: manager.current };
  }
  if (manager.updateAvailable && manager.latest !== null) {
    return {
      kind: "available",
      current: manager.current,
      latest: manager.latest,
      canUpdate: isAdmin,
    };
  }
  return { kind: "current", version: manager.current };
}

/** Where the card keeps the version it saw the switch to, across the reload that follows. */
export const UPDATED_TO_KEY = "appflare:updated-to";

/** The "updated" card hides after this long, unless a health check or a dismissal ends it first. */
export const UPDATED_CARD_MS = 30_000;
