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

export interface VerifiedBadgeCopy {
  verified: boolean;
  /** On the badge: the day, or that there is none yet. */
  label: string;
  /** In the tooltip: the exact time, or what "not verified" means. */
  tooltip: string;
}

/**
 * Copy for the index's `lastVerified`: when the catalog's nightly install check
 * last installed this exact version into a test account and got an answer
 * from it. A new version starts unverified; a failing check keeps the previous
 * date, so an old date means recent checks failed.
 */
export function verifiedBadgeCopy(lastVerified: string | null): VerifiedBadgeCopy {
  if (lastVerified === null) {
    return {
      verified: false,
      label: "Not verified yet",
      tooltip: "The catalog's nightly install check has not passed for this version yet.",
    };
  }
  return {
    verified: true,
    label: `Verified ${formatDate(lastVerified)}`,
    tooltip: `Install check passed ${formatExactDateTime(lastVerified)}.`,
  };
}
