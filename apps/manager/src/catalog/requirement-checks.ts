import type { Plan } from "@appflare/schema";
import type { CapabilitiesView } from "../capabilities/capabilities";
import {
  ANALYTICS_ENGINE_FIX,
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

/**
 * `accessIfProtected`: the entry needs Cloudflare Access only while the app
 * is protected (`accessNeededOnlyIfProtected`), so `"access"` is no check
 * of its own: the install form checks it when protection is turned on.
 */
export function requirementChecks(
  app: { plan: Plan; requires: readonly string[]; accessIfProtected?: boolean | undefined },
  view: CapabilitiesView,
): RequirementChecks {
  const checks: RequirementCheck[] = [];
  if (app.plan === "paid") {
    checks.push({ key: "plan", label: "Workers Paid", ...workersPaidStatus(view) });
  }
  for (const requirement of app.requires) {
    if (requirement === "access" && app.accessIfProtected === true) continue;
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

/** What an app is known to use, from its `requires`, its index row and its Worker's bindings. */
export interface AnalyticsEngineUse {
  requires: readonly string[];
  /** The services the index row publishes, when it does. */
  services?: readonly string[] | undefined;
  /** The Worker's bindings, when an artifact records them (wrangler's type names). */
  bindings?: ReadonlyArray<{ type: string }> | undefined;
}

/** Whether an app writes to Analytics Engine: it asks for it, or binds a dataset. */
export function usesAnalyticsEngine(app: AnalyticsEngineUse): boolean {
  return (
    app.requires.includes("analytics-engine") ||
    (app.services ?? []).includes("analytics-engine") ||
    (app.bindings ?? []).some((b) => b.type === "analytics_engine")
  );
}

/**
 * Why an app cannot be installed while Analytics Engine is off, or null.
 * Cloudflare refuses to deploy a Worker that binds a dataset until Analytics
 * Engine is turned on for the account, so a detected "not turned on" stops
 * the install before anything is created. When the probe could not tell, the
 * requirement stays for the admin to confirm like any other.
 */
export function analyticsEngineRefusal(
  appName: string,
  app: AnalyticsEngineUse,
  // The view, or the stored probe row (where a row from before the probe has none).
  view: { analyticsEngine?: CapabilitiesView["analyticsEngine"] | undefined } | null,
): string | null {
  if (view?.analyticsEngine?.state !== "not-enabled" || !usesAnalyticsEngine(app)) return null;
  return `${appName} writes to Analytics Engine, which is not turned on for this account. ${ANALYTICS_ENGINE_FIX}`;
}
