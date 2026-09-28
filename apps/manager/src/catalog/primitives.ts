import {
  type AppServices,
  deriveServices,
  type IndexApp,
  type InstallTier,
  requirementService,
  SERVICE_IDS,
  type ServiceId,
  type ServiceSources,
} from "@appflare/schema";
import type { CapabilitiesView } from "../capabilities/capabilities";

/**
 * The Cloudflare primitives an app uses, as the catalog shows them: one icon
 * per primitive on each card and a badge per primitive on the app's page,
 * each marked available, not available, or unknown for this account.
 * Client-safe: the catalog list and the app page read the same words.
 */

/**
 * Every primitive the catalog shows, in display order. They are the services
 * `@appflare/schema` works out from an app's manifests and the catalog index
 * publishes per app, so the catalog and the manager share one list.
 */
export const PRIMITIVE_IDS = SERVICE_IDS;
export type PrimitiveId = ServiceId;

export const PRIMITIVE_LABELS: Record<PrimitiveId, string> = {
  kv: "KV",
  d1: "D1",
  r2: "R2",
  "durable-objects": "Durable Objects",
  // What the admin brings, not the Cloudflare product that connects to it.
  hyperdrive: "Database elsewhere",
  vectorize: "Vectorize",
  "analytics-engine": "Analytics Engine",
  queues: "Queues",
  pipelines: "Pipelines",
  workflows: "Workflows",
  cron: "Cron triggers",
  "workers-ai": "Workers AI",
  "browser-rendering": "Browser Rendering",
  images: "Images",
  containers: "Containers",
  "email-routing": "Email Routing",
  zone: "Domain and DNS",
  access: "Cloudflare Access",
};

/** What an app uses, as far as the manager can tell. */
export interface AppPrimitives extends AppServices {
  /**
   * False when the list may be missing some: neither the index nor the app's
   * manifest has named them yet (only the index's `requires` are known), or
   * the app does not run a prebuilt artifact, so its bindings are known only
   * once it is built or its installer runs.
   */
  complete: boolean;
}

/** The primitive a catalog `requires` value is, or null for one this manager does not know. */
export const requirementPrimitive = requirementService;

/** `deriveServices` from `@appflare/schema`, with whether the sources name everything. */
export function derivePrimitives(sources: ServiceSources & { complete: boolean }): AppPrimitives {
  return { ...deriveServices(sources), complete: sources.complete };
}

/**
 * What an app uses as its index row publishes it. Ids this manager does not
 * know yet are skipped. Complete for an artifact tier app, whose row the
 * catalog worked out from the artifact's Worker.
 */
export function indexPrimitives(
  app: Pick<IndexApp, "tier" | "services" | "keyValueDurableObjects">,
): AppPrimitives {
  const listed = new Set(app.services);
  return {
    ids: PRIMITIVE_IDS.filter((id) => listed.has(id)),
    complete: app.tier === "artifact",
    keyValueDurableObjects: app.keyValueDurableObjects === true,
  };
}

/**
 * `provided`: something the admin brings rather than something the account
 * offers, such as the database an app reaches through Hyperdrive.
 */
export type Availability = "available" | "unavailable" | "unknown" | "provided";

/** A primitive's availability for this account, with the sentence that explains it. */
export interface PrimitiveStatus {
  id: PrimitiveId;
  availability: Availability;
  reason: string;
  /** Included on every plan, so there is nothing on the account to turn on. */
  included?: boolean;
}

const INCLUDED: Partial<Record<PrimitiveId, string>> = {
  kv: "Included on every Workers plan.",
  d1: "Included on every Workers plan.",
  vectorize: "Included on every Workers plan.",
  queues: "Included on every Workers plan.",
  workflows: "Included on every Workers plan.",
  cron: "Included on every Workers plan; Workers Free allows 5 cron triggers per account.",
  "workers-ai": "Included on every Workers plan, with a daily free allocation.",
  "browser-rendering": "Included on every Workers plan, with limited browser time on Workers Free.",
  images: "Included on every Cloudflare plan, with a monthly free allocation.",
};

/** Primitives the admin provides, with what they bring. */
const PROVIDED: Partial<Record<PrimitiveId, string>> = {
  hyperdrive:
    "Provided by you: a PostgreSQL or MySQL database outside Cloudflare, whose connection string you enter when you install. Hyperdrive, included on every Workers plan, connects the app to it.",
};

const NOT_CHECKED: Partial<Record<PrimitiveId, string>> = {
  access: "Needs Cloudflare Access (Zero Trust) on this account. Appflare does not check for it.",
};

/** A domain on the account, as the zone probe found it. */
function zoneStatus(view: CapabilitiesView | null): PrimitiveStatus {
  const id = "zone";
  const state = view?.zone?.state;
  if (state === "available") {
    return { id, availability: "available", reason: "Detected: this account has an active zone." };
  }
  if (state === "none") {
    return {
      id,
      availability: "unavailable",
      reason: "No active zone in this account (or the token lacks Zone: Read).",
    };
  }
  return {
    id,
    availability: "unknown",
    reason: "Needs a domain on this account; Appflare could not check.",
  };
}

/** Email Routing on a domain of the account, as its probe found it. */
function emailRoutingStatus(view: CapabilitiesView | null): PrimitiveStatus {
  const id = "email-routing";
  const state = view?.emailRouting?.state;
  if (state === "available") {
    return {
      id,
      availability: "available",
      reason: "Detected: Email Routing can be used on this account's domain.",
    };
  }
  if (state === "no-zone") {
    return {
      id,
      availability: "unavailable",
      reason:
        "Needs Email Routing on an active zone: no active zone in this account (or the token lacks Zone: Read).",
    };
  }
  return {
    id,
    availability: "unknown",
    reason: "Needs Email Routing on a domain of this account; Appflare could not check.",
  };
}

/**
 * What an admin does about Analytics Engine being off: it is turned on once
 * per account, from its page in the dashboard, and the probe reads it again on
 * Check again.
 */
export const ANALYTICS_ENGINE_FIX =
  "Turn on Analytics Engine once in the dashboard, then choose Check again on Your account.";

/**
 * Analytics Engine, as its probe found it. It is off on an account until
 * someone opens its dashboard page once; until then Cloudflare refuses every
 * deploy of a Worker that binds a dataset.
 */
function analyticsEngineStatus(view: CapabilitiesView | null): PrimitiveStatus {
  const id = "analytics-engine";
  const state = view?.analyticsEngine?.state;
  if (state === "enabled") {
    return { id, availability: "available", reason: "Detected: Analytics Engine is turned on." };
  }
  if (state === "not-enabled") {
    return {
      id,
      availability: "unavailable",
      reason: `Detected: Analytics Engine is not turned on. ${ANALYTICS_ENGINE_FIX}`,
    };
  }
  return {
    id,
    availability: "unknown",
    reason: "Needs Analytics Engine turned on for this account; Appflare could not check.",
  };
}

/**
 * Whether the account is on Workers Paid, as far as the plan in force says:
 * detected, set by an admin, or not known. An admin's "Free" is only the
 * fallback they chose, so it leaves the answer unknown.
 */
export function workersPaidStatus(view: CapabilitiesView | null): {
  availability: Availability;
  reason: string;
} {
  const plan = view?.plan;
  if (plan === undefined || plan.source === "default") {
    return { availability: "unknown", reason: "Needs Workers Paid; the plan is not known." };
  }
  if (plan.plan === "paid") {
    const how = plan.source === "detected" ? "detected" : "as chosen on Your account";
    return { availability: "available", reason: `Needs Workers Paid, ${how}.` };
  }
  return plan.source === "detected"
    ? { availability: "unavailable", reason: "Needs Workers Paid; this account is on Free." }
    : {
        availability: "unknown",
        reason:
          "Needs Workers Paid; the plan chosen on Your account is Free, which Appflare did not detect.",
      };
}

function paidPlanStatus(id: PrimitiveId, view: CapabilitiesView | null): PrimitiveStatus {
  return { id, ...workersPaidStatus(view) };
}

/**
 * Whether this account offers `id`. Primitives every plan includes are
 * available; R2, Containers, domains, Email Routing and Analytics Engine
 * follow the capability probes; key-value Durable Objects and Containers without a probe result
 * follow the plan; Access is not probed, so it stays unknown.
 */
export function primitiveStatus(
  id: PrimitiveId,
  view: CapabilitiesView | null,
  app: Pick<AppPrimitives, "keyValueDurableObjects">,
): PrimitiveStatus {
  const included = INCLUDED[id];
  if (included !== undefined) {
    return { id, availability: "available", reason: included, included: true };
  }
  const provided = PROVIDED[id];
  if (provided !== undefined) return { id, availability: "provided", reason: provided };
  const notChecked = NOT_CHECKED[id];
  if (notChecked !== undefined) return { id, availability: "unknown", reason: notChecked };
  if (id === "zone") return zoneStatus(view);
  if (id === "email-routing") return emailRoutingStatus(view);
  if (id === "analytics-engine") return analyticsEngineStatus(view);
  // Pipelines is in open beta for Workers Paid accounts only.
  if (id === "pipelines") return paidPlanStatus(id, view);
  if (id === "durable-objects") {
    if (!app.keyValueDurableObjects) {
      return {
        id,
        availability: "available",
        reason: "SQLite-backed Durable Objects are included on every Workers plan.",
        included: true,
      };
    }
    return paidPlanStatus(id, view);
  }
  if (id === "r2") {
    const state = view?.r2?.state;
    if (state === "enabled") {
      return { id, availability: "available", reason: "Detected: R2 is enabled." };
    }
    if (state === "not-enabled") {
      return {
        id,
        availability: "unavailable",
        reason: "Detected: R2 is not enabled. Enabling it needs a payment method on file.",
      };
    }
    return { id, availability: "unknown", reason: "Appflare could not check R2 on this account." };
  }
  // Containers: the probe, else the plan they need.
  const state = view?.containers?.state;
  if (state === "available") {
    return { id, availability: "available", reason: "Detected: Containers are available." };
  }
  if (state === "needs-workers-paid") {
    return {
      id,
      availability: "unavailable",
      reason: "Detected: Containers need Workers Paid.",
    };
  }
  return paidPlanStatus(id, view);
}

/** {@link primitiveStatus} for each primitive an app uses, in display order. */
export function primitiveStatuses(
  app: AppPrimitives,
  view: CapabilitiesView | null,
): PrimitiveStatus[] {
  return app.ids.map((id) => primitiveStatus(id, view, app));
}

/** The word for each availability, on badges, in tooltips and in the legend. */
export const AVAILABILITY_LABELS: Record<Availability, string> = {
  available: "Available",
  unavailable: "Not available",
  unknown: "Unknown",
  provided: "Provided by you",
};

/**
 * Why an app's list of primitives may be incomplete, in one sentence; null
 * when it is complete.
 */
export function primitivesNote(
  primitives: Pick<AppPrimitives, "complete">,
  tier: InstallTier,
): string | null {
  if (primitives.complete) return null;
  if (tier === "sandbox") return "Built in your account, so the rest is known once it is built.";
  if (tier === "self-deploying") {
    return "Its own installer creates what it needs; this is what its token allows.";
  }
  return "Appflare has not read this version's manifest yet, so only its requirements are shown.";
}
