import type { Plan } from "@appflare/schema";
import type { CapabilitiesView } from "../capabilities/capabilities";
import {
  type Availability,
  primitiveStatus,
  requirementPrimitive,
  workersPaidStatus,
} from "./primitives";
import { requirementLabel } from "./requirements";

/**
 * What an app asks of the account before it installs (Workers Paid, and each
 * `requires` value), split into what this account is known to offer and what
 * the admin still has to look at. Only the second list is a warning. Client-safe.
 */

/** One thing the app needs from the account. `key` is `plan` or the `requires` value. */
export interface RequirementCheck {
  key: string;
  label: string;
  availability: Availability;
  reason: string;
}

export interface RequirementChecks {
  /** Known to be available: shown as a quiet line, never as a warning. */
  met: RequirementCheck[];
  /** Not available, or not known: the warning lists these and the admin confirms them. */
  pending: RequirementCheck[];
}

export function requirementChecks(
  app: { plan: Plan; requires: readonly string[] },
  view: CapabilitiesView,
): RequirementChecks {
  const checks: RequirementCheck[] = [];
  if (app.plan === "paid") {
    checks.push({ key: "plan", label: "Workers Paid", ...workersPaidStatus(view) });
  }
  for (const requirement of app.requires) {
    const primitive = requirementPrimitive(requirement);
    const status =
      primitive === null
        ? { availability: "unknown" as const, reason: "Appflare does not know this requirement." }
        : primitiveStatus(primitive, view, { keyValueDurableObjects: false });
    checks.push({
      key: requirement,
      label: requirementLabel(requirement),
      availability: status.availability,
      reason: status.reason,
    });
  }
  return {
    met: checks.filter((c) => c.availability === "available"),
    pending: checks.filter((c) => c.availability !== "available"),
  };
}
