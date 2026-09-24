import type { InstallTier } from "@appflare/schema";
import type { CapabilitiesView } from "../capabilities/capabilities";

/**
 * The Cloudflare primitives an app uses, as the catalog shows them: one icon
 * per primitive on each card and a badge per primitive on the app's page,
 * each marked available, not available, or unknown for this account.
 * Client-safe: the catalog list and the app page read the same words.
 */

/** Every primitive the catalog shows, in display order: storage, compute, then account-level services. */
export const PRIMITIVE_IDS = [
  "kv",
  "d1",
  "r2",
  "durable-objects",
  "hyperdrive",
  "vectorize",
  "queues",
  "workflows",
  "cron",
  "workers-ai",
  "browser-rendering",
  "images",
  "containers",
  "email-routing",
  "zone",
  "access",
] as const;
export type PrimitiveId = (typeof PRIMITIVE_IDS)[number];

export const PRIMITIVE_LABELS: Record<PrimitiveId, string> = {
  kv: "KV",
  d1: "D1",
  r2: "R2",
  "durable-objects": "Durable Objects",
  hyperdrive: "Hyperdrive",
  vectorize: "Vectorize",
  queues: "Queues",
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
export interface AppPrimitives {
  /** In {@link PRIMITIVE_IDS} order, each once. */
  ids: PrimitiveId[];
  /**
   * False when the list may be missing some: the app's manifest has not been
   * read yet (only the index's `requires` are known), or it is built in the
   * account, so its bindings are known only after the build.
   */
  complete: boolean;
  /**
   * The app declares key-value backed Durable Objects (`new_classes`), which
   * need Workers Paid; SQLite-backed ones run on every plan.
   */
  keyValueDurableObjects: boolean;
}

/** Binding types (wrangler's names, as the artifact records them) and the primitive each one is. */
const BINDING_PRIMITIVES: Readonly<Record<string, PrimitiveId>> = {
  kv_namespace: "kv",
  d1: "d1",
  r2_bucket: "r2",
  durable_object_namespace: "durable-objects",
  hyperdrive: "hyperdrive",
  vectorize: "vectorize",
  queue: "queues",
  workflow: "workflows",
  ai: "workers-ai",
  browser: "browser-rendering",
  images: "images",
  // Sending from a Worker delivers only to addresses verified in Email Routing.
  send_email: "email-routing",
};

/** Catalog `requires` values and the primitive each one is. */
const REQUIREMENT_PRIMITIVES: Readonly<Record<string, PrimitiveId>> = {
  r2: "r2",
  zone: "zone",
  "email-routing": "email-routing",
  "workers-ai": "workers-ai",
  "browser-rendering": "browser-rendering",
  containers: "containers",
};

/** The primitive a catalog `requires` value is, or null for one this manager does not know. */
export function requirementPrimitive(requirement: string): PrimitiveId | null {
  return REQUIREMENT_PRIMITIVES[requirement] ?? null;
}

/**
 * Words in a token permission group's name and the primitive the group
 * reaches. Names are free text in the catalog manifest ("Workers KV Storage",
 * "Zone.DNS", "Access: Apps and Policies"), so this matches words, not ids.
 */
const PERMISSION_PRIMITIVES: ReadonlyArray<readonly [RegExp, PrimitiveId]> = [
  [/\bkv\b/i, "kv"],
  [/\bd1\b/i, "d1"],
  [/\br2\b/i, "r2"],
  [/\bdurable objects?\b/i, "durable-objects"],
  [/\bhyperdrive\b/i, "hyperdrive"],
  [/\bvectorize\b/i, "vectorize"],
  [/\bqueues?\b/i, "queues"],
  [/\bworkflows?\b/i, "workflows"],
  [/\bworkers ai\b/i, "workers-ai"],
  [/\bbrowser rendering\b/i, "browser-rendering"],
  [/\bcontainers?\b/i, "containers"],
  [/\bemail routing\b/i, "email-routing"],
  [/\bdns\b/i, "zone"],
  [/\baccess\b/i, "access"],
];

/** The parts of an artifact and catalog manifest the primitives come from; every field optional. */
export interface PrimitiveSources {
  bindings?: ReadonlyArray<{ type: string }>;
  /** Durable Object migrations, wrangler's shape. */
  migrations?: ReadonlyArray<Record<string, unknown>>;
  crons?: readonly string[];
  /** Queue consumers: the Worker receives messages from a queue. */
  queueConsumers?: readonly unknown[];
  requires?: readonly string[];
  tokenPermissions?: ReadonlyArray<{ name: string; scope?: string | undefined }>;
  /** The manifest sets `install.emailRouting`: the install routes a domain's mail to the app. */
  emailRouting?: boolean;
  /** False when the sources may not name everything the app uses. */
  complete: boolean;
}

function declaresKeyValueClasses(migration: Record<string, unknown>): boolean {
  const added = migration.new_classes;
  return Array.isArray(added) && added.length > 0;
}

/** What an app uses, from whichever of its manifests' parts are known. */
export function derivePrimitives(sources: PrimitiveSources): AppPrimitives {
  const found = new Set<PrimitiveId>();
  for (const binding of sources.bindings ?? []) {
    const id = BINDING_PRIMITIVES[binding.type];
    if (id !== undefined) found.add(id);
  }
  if ((sources.queueConsumers ?? []).length > 0) found.add("queues");
  if ((sources.crons ?? []).length > 0) found.add("cron");
  for (const requirement of sources.requires ?? []) {
    const id = REQUIREMENT_PRIMITIVES[requirement];
    if (id !== undefined) found.add(id);
  }
  if (sources.emailRouting === true) {
    found.add("email-routing");
    found.add("zone");
  }
  for (const permission of sources.tokenPermissions ?? []) {
    if (permission.scope === "zone") found.add("zone");
    for (const [pattern, id] of PERMISSION_PRIMITIVES) {
      if (pattern.test(permission.name)) found.add(id);
    }
  }
  const keyValueDurableObjects = (sources.migrations ?? []).some(declaresKeyValueClasses);
  if (keyValueDurableObjects) found.add("durable-objects");
  return {
    ids: PRIMITIVE_IDS.filter((id) => found.has(id)),
    complete: sources.complete,
    keyValueDurableObjects,
  };
}

export type Availability = "available" | "unavailable" | "unknown";

/** A primitive's availability for this account, with the sentence that explains it. */
export interface PrimitiveStatus {
  id: PrimitiveId;
  availability: Availability;
  reason: string;
}

const INCLUDED: Partial<Record<PrimitiveId, string>> = {
  kv: "Included on every Workers plan.",
  d1: "Included on every Workers plan.",
  hyperdrive: "Included on every Workers plan.",
  vectorize: "Included on every Workers plan.",
  queues: "Included on every Workers plan.",
  workflows: "Included on every Workers plan.",
  cron: "Included on every Workers plan; Workers Free allows 5 cron triggers per account.",
  "workers-ai": "Included on every Workers plan, with a daily free allocation.",
  "browser-rendering": "Included on every Workers plan, with limited browser time on Workers Free.",
  images: "Included on every Cloudflare plan, with a monthly free allocation.",
};

const NOT_CHECKED: Partial<Record<PrimitiveId, string>> = {
  zone: "Needs a domain on this account. Appflare does not check for one.",
  "email-routing":
    "Needs Email Routing on a domain of this account. Appflare does not check for it.",
  access: "Needs Cloudflare Access (Zero Trust) on this account. Appflare does not check for it.",
};

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
    const how = plan.source === "detected" ? "detected" : "set in Settings";
    return { availability: "available", reason: `Needs Workers Paid, ${how}.` };
  }
  return plan.source === "detected"
    ? { availability: "unavailable", reason: "Needs Workers Paid; this account is on Free." }
    : {
        availability: "unknown",
        reason: "Needs Workers Paid; Settings says Free, which Appflare did not detect.",
      };
}

function paidPlanStatus(id: PrimitiveId, view: CapabilitiesView | null): PrimitiveStatus {
  return { id, ...workersPaidStatus(view) };
}

/**
 * Whether this account offers `id`. Primitives every plan includes are
 * available; R2 and Containers follow the capability probes; key-value
 * Durable Objects and Containers without a probe result follow the plan;
 * domains, Email Routing and Access are not probed, so they stay unknown.
 */
export function primitiveStatus(
  id: PrimitiveId,
  view: CapabilitiesView | null,
  app: Pick<AppPrimitives, "keyValueDurableObjects">,
): PrimitiveStatus {
  const included = INCLUDED[id];
  if (included !== undefined) return { id, availability: "available", reason: included };
  const notChecked = NOT_CHECKED[id];
  if (notChecked !== undefined) return { id, availability: "unknown", reason: notChecked };
  if (id === "durable-objects") {
    if (!app.keyValueDurableObjects) {
      return {
        id,
        availability: "available",
        reason: "SQLite-backed Durable Objects are included on every Workers plan.",
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
