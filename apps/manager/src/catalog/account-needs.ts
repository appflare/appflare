import type { Plan } from "@appflare/schema";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { resourceKindLabel } from "../components/format";
import { dashboardLinks } from "../onboarding/checklist";
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
 * ("Email Routing · ready", "R2 storage · not turned on"), and for a need
 * the account lacks, where on the Cloudflare dashboard to fix it. The
 * probe's own sentence is kept as `detail`. Client-safe.
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

/** Where on the Cloudflare dashboard to fix a need the account lacks ("Turn on", "Upgrade"). */
export interface NeedFix {
  label: string;
  href: string;
}

/**
 * The fix for each need that can be missing and has a dashboard page to fix
 * it, the same deep links into the account as the account checklist. A need
 * that needs Workers Paid is fixed by upgrading; Email Routing, by adding a
 * domain first.
 */
function needFixes(accountId: string | null): Partial<Record<PrimitiveId | "plan", NeedFix>> {
  const links = dashboardLinks(accountId);
  const upgrade: NeedFix = { label: "Upgrade", href: links.workersPlans };
  const addDomain: NeedFix = { label: "Add a domain", href: links.domains };
  return {
    plan: upgrade,
    r2: { label: "Turn on", href: links.r2 },
    "analytics-engine": { label: "Turn on", href: links.analyticsEngine },
    zone: addDomain,
    "email-routing": addDomain,
    containers: upgrade,
    "durable-objects": upgrade,
    pipelines: upgrade,
    access: { label: "Set up", href: links.zeroTrust },
  };
}

/** The dashboard fix for a need, only when it is missing. */
function fixOf(key: string, tone: NeedTone, accountId: string | null): NeedFix | null {
  if (tone !== "missing") return null;
  return needFixes(accountId)[key as PrimitiveId | "plan"] ?? null;
}

export interface AccountNeed {
  key: string;
  name: string;
  /** The state in a few words, after the name. */
  state: string;
  tone: NeedTone;
  /** The probe's sentence: what was checked and what it found. */
  detail: string;
  /** Where to fix it on the dashboard; null unless the need is missing and has such a page. */
  fix: NeedFix | null;
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

function needOf(status: PrimitiveStatus, accountId: string | null): AccountNeed {
  const tone = TONES[status.availability];
  return {
    key: status.id,
    name: NEED_NAMES[status.id],
    state: stateOf(status.id, status.availability, status.reason),
    tone,
    detail: status.reason,
    fix: fixOf(status.id, tone, accountId),
  };
}

/** Problems first, then what is not confirmed, then what is ready. */
const ORDER: Record<NeedTone, number> = { missing: 0, unknown: 1, yours: 2, ready: 3 };

function planNeed(
  availability: Availability,
  reason: string,
  accountId: string | null,
): AccountNeed {
  const tone = TONES[availability];
  return {
    key: "plan",
    name: "Workers Paid plan",
    state:
      availability === "available"
        ? "ready"
        : availability === "unavailable"
          ? "this account is on Free"
          : "not confirmed",
    tone,
    detail: reason,
    fix: fixOf("plan", tone, accountId),
  };
}

/**
 * One requirement check (`requirementChecks`) in the same words as the
 * rows: the Workers Paid plan, a primitive, or a requirement this manager
 * does not know. `accountId` is the account the fix links open (null: the
 * dashboard asks).
 */
export function needOfCheck(check: RequirementCheck, accountId: string | null): AccountNeed {
  if (check.key === "plan") return planNeed(check.availability, check.reason, accountId);
  const primitive = requirementPrimitive(check.key);
  if (primitive !== null) {
    return needOf(
      { id: primitive, availability: check.availability, reason: check.reason },
      accountId,
    );
  }
  return {
    key: check.key,
    name: check.label,
    state: stateOf(check.key, check.availability, check.reason),
    tone: TONES[check.availability],
    detail: check.reason,
    fix: null,
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
  const accountId = view?.accountId ?? null;
  if (app.plan === "paid") {
    const status = workersPaidStatus(view);
    needs.push(planNeed(status.availability, status.reason, accountId));
  }
  needs.push(...primitiveStatuses(primitives, view).map((status) => needOf(status, accountId)));
  for (const requirement of app.requires) {
    if (requirementPrimitive(requirement) !== null) continue;
    needs.push({
      key: requirement,
      name: requirementLabel(requirement),
      state: "not confirmed",
      tone: "unknown",
      detail: "Appflare does not know how to check this on your account.",
      fix: null,
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
