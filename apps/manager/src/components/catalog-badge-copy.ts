import type { Plan } from "@appflare/schema";
import { formatDate, formatExactDateTime } from "./format";

/**
 * The words the catalog badges use, kept apart from the React components so
 * tests can check them without loading the UI libraries into the test runtime.
 */

export const PLAN_BADGES: Record<Plan, { variant: "neutral" | "orange"; label: string }> = {
  free: { variant: "neutral", label: "Free plan" },
  paid: { variant: "orange", label: "Workers Paid" },
};

export interface InstallCheckBadgeCopy {
  checked: boolean;
  /** On the badge: the day, or that there is none yet. */
  label: string;
  /** In the tooltip: what the check did and exactly when, or that it has not passed yet. */
  tooltip: string;
}

/**
 * Copy for the index's `lastVerified`: when the catalog's nightly job last
 * reinstalled this exact package into a test account and got an answer from
 * it. A new version starts unchecked; a failing check keeps the previous
 * date, so an old date means recent checks failed.
 *
 * Worded as "install checked" rather than "verified" so it is not confused
 * with an install's own health status in this account.
 */
export function installCheckBadgeCopy(lastVerified: string | null): InstallCheckBadgeCopy {
  if (lastVerified === null) {
    return {
      checked: false,
      label: "Not checked yet",
      tooltip:
        "The catalog's nightly job has not yet reinstalled this version into a test account and seen it answer.",
    };
  }
  return {
    checked: true,
    label: `Install checked ${formatDate(lastVerified)}`,
    tooltip: `The catalog's nightly job reinstalled this exact package into a test account on ${formatExactDateTime(lastVerified)}, and it answered.`,
  };
}
