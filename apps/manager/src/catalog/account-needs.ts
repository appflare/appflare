import type { Plan } from "@appflare/schema";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { resourceKindLabel } from "../components/format";
import {
  type AppPrimitives,
  type Availability,
  type PrimitiveId,
  type PrimitiveStatus,
  primitiveStatuses,
  requirementPrimitive,
  workersPaidStatus,
} from "./primitives";
import type { RequirementCheck } from "./requirement-checks";
import { requirementLabel } from "./requirements";

/**
 * "What it needs on your account" on an app's catalog page: one row per
 * thing the app uses, named in plain words, with its state on this account
 * ("Email Routing · ready", "R2 storage · not turned on"). The probe's own
 * sentence is kept for the row's tooltip. Client-safe.
 */

/** Plain names for what an app uses; the product name stays where people know it by it. */
const NEED_NAMES: Record<PrimitiveId, string> = {
  kv: "KV storage",
  d1: "D1 database",
  r2: "R2 storage",
  "durable-objects": "Durable Objects",
  hyperdrive: "Your own database",
  vectorize: "Vector search",
  "analytics-engine": "Analytics Engine",
  queues: "Queues",
  pipelines: "Pipelines",
  workflows: "Workflows",
  cron: "Runs on a schedule",
  "workers-ai": "Workers AI",
  "browser-rendering": "Browser Rendering",
  images: "Cloudflare Images",
  containers: "Containers",
  "email-routing": "Email Routing",
  zone: "A domain",
  access: "Cloudflare Access",
};

/** What a missing primitive lacks, where "not available" would not say it. */
const UNAVAILABLE_STATES: Partial<Record<PrimitiveId, string>> = {
  r2: "not turned on",
  "analytics-engine": "not turned on",
  zone: "no domain on this account",
  "email-routing": "needs a domain on this account",
  containers: "needs Workers Paid",
  "durable-objects": "needs Workers Paid",
  pipelines: "needs Workers Paid",
};

export type NeedTone = "ready" | "missing" | "unknown" | "yours";

export interface AccountNeed {
  key: string;
  name: string;
  /** The state in a few words, after the name. */
  state: string;
  tone: NeedTone;
  /** The probe's sentence: what was checked and what it found. */
  detail: string;
}

const TONES: Record<Availability, NeedTone> = {
  available: "ready",
  unavailable: "missing",
  unknown: "unknown",
  provided: "yours",
};

function stateOf(id: string, availability: Availability, reason: string): string {
  switch (availability) {
    case "available":
      // Included on every plan, so nothing on the account to turn on.
      return reason.startsWith("Included") || reason.startsWith("SQLite-backed")
        ? "included"
        : "ready";
    case "unavailable":
      return UNAVAILABLE_STATES[id as PrimitiveId] ?? "not available";
    case "unknown":
      return "not confirmed";
    case "provided":
      return "you provide it";
  }
}

function needOf(status: PrimitiveStatus): AccountNeed {
  return {
    key: status.id,
    name: NEED_NAMES[status.id],
    state: stateOf(status.id, status.availability, status.reason),
    tone: TONES[status.availability],
    detail: status.reason,
  };
}

/** Problems first, then what is not confirmed, then what is ready. */
const ORDER: Record<NeedTone, number> = { missing: 0, unknown: 1, yours: 2, ready: 3 };

function planNeed(availability: Availability, reason: string): AccountNeed {
  return {
    key: "plan",
    name: "Workers Paid plan",
    state:
      availability === "available"
        ? "ready"
        : availability === "unavailable"
          ? "this account is on Free"
          : "not confirmed",
    tone: TONES[availability],
    detail: reason,
  };
}

/**
 * One requirement check (`requirementChecks`) in the same words as the
 * rows: the Workers Paid plan, a primitive, or a requirement this manager
 * does not know.
 */
export function needOfCheck(check: RequirementCheck): AccountNeed {
  if (check.key === "plan") return planNeed(check.availability, check.reason);
  const primitive = requirementPrimitive(check.key);
  if (primitive !== null) {
    return needOf({ id: primitive, availability: check.availability, reason: check.reason });
  }
  return {
    key: check.key,
    name: check.label,
    state: stateOf(check.key, check.availability, check.reason),
    tone: TONES[check.availability],
    detail: check.reason,
  };
}

/**
 * Every need of the app: the Workers Paid plan when it asks for it, each
 * primitive it uses, and any `requires` value this manager has no primitive
 * for. Sorted so what stands in the way comes first.
 */
export function accountNeeds(
  app: { plan: Plan; requires: readonly string[] },
  primitives: AppPrimitives,
  view: CapabilitiesView | null,
): AccountNeed[] {
  const needs: AccountNeed[] = [];
  if (app.plan === "paid") {
    const status = workersPaidStatus(view);
    needs.push(planNeed(status.availability, status.reason));
  }
  needs.push(...primitiveStatuses(primitives, view).map(needOf));
  for (const requirement of app.requires) {
    if (requirementPrimitive(requirement) !== null) continue;
    needs.push({
      key: requirement,
      name: requirementLabel(requirement),
      state: "not confirmed",
      tone: "unknown",
      detail: "Appflare does not know how to check this on your account.",
    });
  }
  return needs
    .map((need, i) => ({ need, i }))
    .sort((a, b) => ORDER[a.need.tone] - ORDER[b.need.tone] || a.i - b.i)
    .map(({ need }) => need);
}

/** "2 KV namespaces", "a D1 database": one kind of resource and how many. */
function countOf(label: string, n: number): string {
  if (n === 1) return `${/^(?:[AEIOU]|R2\b)/.test(label) ? "an" : "a"} ${label}`;
  return `${n} ${label.endsWith("s") ? label : `${label}s`}`;
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * What the install adds to the account, in one sentence ("The install adds
 * the app's Worker, 2 KV namespaces and a D1 database."), with the binding
 * names for the tooltip. Only for an app whose resources are known before
 * it installs: a build or an app's own installer decides them later.
 */
export function installAdds(
  creates: ReadonlyArray<{ kind: string; binding: string }>,
  durableObjects: readonly string[],
): { sentence: string; detail: string | null } {
  const counts = new Map<string, number>();
  for (const c of creates) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  if (durableObjects.length > 0) counts.set("durable_object", durableObjects.length);
  const parts = [
    "the app's Worker",
    ...[...counts].map(([kind, n]) => countOf(resourceKindLabel(kind), n)),
  ];
  const named = [
    ...creates.map((c) => `${c.binding} (${resourceKindLabel(c.kind)})`),
    ...durableObjects.map((d) => `${d} (${resourceKindLabel("durable_object")})`),
  ];
  return {
    sentence: `The install adds ${listOf(parts)} to your account.`,
    detail: named.length === 0 ? null : `Named in the app: ${named.join(", ")}.`,
  };
}
