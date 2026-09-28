import type { InstallTier, Plan } from "@appflare/schema";
import { SERVICE_NAMES, serviceNeedWords } from "@appflare/schema/catalog-display";
import { type CapabilitiesView, PLAN_LABELS } from "../capabilities/capabilities";
import {
  CAPABILITY_STATE_LABELS,
  type CapabilityId,
  type CapabilityRow,
  capabilityAnchor,
  capabilityRows,
  catalogNeeds,
} from "../capabilities/capability-rows";
import { dashboardLinks } from "../cloudflare/dashboard-links";
import { resourceKindLabel } from "../components/format";
import { settingsLink } from "../components/settings-links";
import {
  type AppPrimitives,
  type PrimitiveId,
  type PrimitiveStatus,
  primitiveStatus,
  requirementPrimitive,
} from "./primitives";
import type { RequirementCheck } from "./requirement-checks";
import { requirementLabel } from "./requirements";

/**
 * "What it needs on your account" on an app's catalog page, and the rows of
 * its "Before you install" banner: one row per thing the app uses, with its
 * state on this account. What the account can lack (the Workers plan, R2, a
 * domain, Email Routing, Analytics Engine, Zero Trust) is read from the same
 * capability rows as "What this account can run" on Your account, so both
 * pages use one name, one state and one action for it. The rows are built
 * as if this app were already in the account: something nothing else uses
 * yet, and so only "Not set up" there, is needed here, and this app is why.
 * Client-safe.
 */

/** The row of "What this account can run" each need is, where it has one. */
const NEED_CAPABILITIES: Partial<Record<PrimitiveId, CapabilityId>> = {
  r2: "r2",
  zone: "zone",
  "email-routing": "email-routing",
  "analytics-engine": "analytics-engine",
  access: "zero-trust",
};

/** What only Workers Paid includes, so the Workers plan decides what to do about it. */
const WITH_WORKERS_PAID: ReadonlySet<PrimitiveId> = new Set([
  "containers",
  "durable-objects",
  "pipelines",
]);

export type NeedTone = "ready" | "missing" | "unknown" | "yours";

/** A link on a need's row. */
export interface NeedLink {
  label: string;
  href: string;
}

export interface AccountNeed {
  key: string;
  name: string;
  /**
   * The state in a word or two: the state of its row on Your account
   * ("Ready", "Needs action", "Paid plan only", "Could not check"), or
   * "Included" and "You provide it" for what no account lacks.
   */
  state: string;
  tone: NeedTone;
  /** For a need that is not met: in plain words, why this app counts it. Null otherwise. */
  reason: string | null;
  /** The Cloudflare dashboard page that fixes it, opened in a new tab; null when there is none. */
  fix: NeedLink | null;
  /**
   * Its row on Your account, for a need that is not met: "See in Your
   * account", or "Choose plan" while the Workers plan is not known.
   */
  more: NeedLink | null;
}

/** An app, as far as what it needs from the account goes. */
export interface AppNeedsOf {
  plan: Plan;
  requires: readonly string[];
  tier: InstallTier;
}

/** The capability rows as they stand with this app in the account. */
type RowsById = ReadonlyMap<CapabilityId, CapabilityRow>;

interface NeedsContext {
  view: CapabilitiesView;
  primitives: AppPrimitives;
  /** Everything the app uses: its primitives, then any `requires` value they leave out. */
  services: readonly PrimitiveId[];
  /**
   * What the app's `requires` names. The rest was worked out from its
   * bindings or its token's permissions: the app uses it, as far as
   * Appflare can tell, rather than saying it needs it.
   */
  declared: ReadonlySet<PrimitiveId>;
  rows: RowsById;
}

function needsContext(
  app: AppNeedsOf,
  primitives: AppPrimitives,
  view: CapabilitiesView,
): NeedsContext {
  const declared = new Set<PrimitiveId>();
  for (const requirement of app.requires) {
    const id = requirementPrimitive(requirement);
    if (id !== null) declared.add(id);
  }
  // An index row written before a `requires` value was worked out into its
  // services still gets a row for it.
  const services = [...new Set<PrimitiveId>([...primitives.ids, ...declared])];
  // The app counts as one in the account, so what it uses and the account
  // lacks is "Needs action" rather than "Not set up".
  const inUse = catalogNeeds([{ plan: app.plan, requires: [], services, tier: app.tier }]);
  const rows = capabilityRows({ view, sandbox: "off", needs: null, inUse });
  return {
    view,
    primitives,
    services,
    declared,
    rows: new Map(rows.map((row) => [row.id, row])),
  };
}

function rowOf(rows: RowsById, id: CapabilityId): CapabilityRow {
  const row = rows.get(id);
  // capabilityRows returns one row per id, so this only guards the lookup.
  if (row === undefined) throw new Error(`No capability row "${id}".`);
  return row;
}

/** The link to a row of "What this account can run" on Your account. */
function seeInYourAccount(id: CapabilityId, label = "See in Your account"): NeedLink {
  return { label, href: settingsLink("account", capabilityAnchor(id)) };
}

const MET = { reason: null, fix: null, more: null } as const;

function ready(key: string, name: string, state = CAPABILITY_STATE_LABELS.ready): AccountNeed {
  return { key, name, state, tone: "ready", ...MET };
}

/**
 * A need the Workers plan decides: the plan itself when the app needs
 * Workers Paid, or something only Workers Paid includes. On Workers Free it
 * is paid plan only, fixed by upgrading; while the plan is not known, it
 * takes the Workers plan row's state, with "Choose plan" there.
 */
function workersPaidNeed(
  key: string,
  name: string,
  ctx: NeedsContext,
  /** The reason's first words: "This app needs", "It needs". */
  subject: string,
  /**
   * A probe found it needs Workers Paid. That wins over the plan in force,
   * which an admin may have stated wrongly.
   */
  detectedPaidOnly = false,
): AccountNeed {
  const { plan } = ctx.view;
  if (!detectedPaidOnly && plan.source !== "default" && plan.plan === "paid") {
    return ready(key, name);
  }
  if (plan.source !== "default" || detectedPaidOnly) {
    return {
      key,
      name,
      state: CAPABILITY_STATE_LABELS["paid-only"],
      tone: "missing",
      reason:
        plan.source !== "default" && plan.plan === "free"
          ? `${subject} Workers Paid, and this account is on ${PLAN_LABELS.free}.`
          : `${subject} Workers Paid, and Cloudflare says this account does not have it.`,
      fix: { label: "Upgrade", href: dashboardLinks(ctx.view.accountId).workersPlans },
      more: seeInYourAccount("workers-plan"),
    };
  }
  const row = rowOf(ctx.rows, "workers-plan");
  return {
    key,
    name,
    state: CAPABILITY_STATE_LABELS[row.state],
    tone: row.state === "needs-action" ? "missing" : "unknown",
    reason: `${subject} Workers Paid, and Appflare cannot tell this account's plan.`,
    fix: null,
    more: seeInYourAccount("workers-plan", "Choose plan"),
  };
}

/** The Workers plan, for an app that needs Workers Paid; named as its row on Your account. */
function planNeed(ctx: NeedsContext): AccountNeed {
  return workersPaidNeed("plan", rowOf(ctx.rows, "workers-plan").name, ctx, "This app needs");
}

/**
 * A need with its own row on Your account: that row's name and state and,
 * when it is not ready, why apps need it, the row's dashboard action, and a
 * link to the row. `declared`: the app's `requires` names it, so the app
 * needs it; otherwise it was worked out from what the app binds, and the
 * app uses it.
 */
function capabilityNeed(key: string, row: CapabilityRow, declared: boolean): AccountNeed {
  if (row.state === "ready") return ready(key, row.name);
  // Built with this app in the account, a probe row is never "Not set up".
  const state = row.state === "not-set-up" ? "needs-action" : row.state;
  const fix =
    row.action !== null && "href" in row.action
      ? { label: row.action.label, href: row.action.href }
      : null;
  return {
    key,
    name: row.name,
    state: CAPABILITY_STATE_LABELS[state],
    tone: state === "could-not-check" ? "unknown" : "missing",
    reason: `${serviceNeedWords(declared)}. ${row.why}`,
    fix,
    more: seeInYourAccount(row.id),
  };
}

/** What no account lacks: included on every plan, or brought by the admin. */
function primitiveOnly(status: PrimitiveStatus): AccountNeed {
  const key = status.id;
  const name = SERVICE_NAMES[status.id];
  switch (status.availability) {
    case "available":
      return ready(
        key,
        name,
        status.included === true ? "Included" : CAPABILITY_STATE_LABELS.ready,
      );
    case "provided":
      return { key, name, state: "You provide it", tone: "yours", ...MET };
    case "unavailable":
      return {
        key,
        name,
        state: "Not available",
        tone: "missing",
        reason: status.reason,
        fix: null,
        more: null,
      };
    case "unknown":
      return {
        key,
        name,
        state: CAPABILITY_STATE_LABELS["could-not-check"],
        tone: "unknown",
        reason: status.reason,
        fix: null,
        more: null,
      };
  }
}

function primitiveNeed(id: PrimitiveId, ctx: NeedsContext): AccountNeed {
  const capability = NEED_CAPABILITIES[id];
  if (capability !== undefined) {
    return capabilityNeed(id, rowOf(ctx.rows, capability), ctx.declared.has(id));
  }
  const status = primitiveStatus(id, ctx.view, ctx.primitives);
  if (WITH_WORKERS_PAID.has(id) && status.availability !== "available") {
    return workersPaidNeed(
      id,
      SERVICE_NAMES[id],
      ctx,
      "It needs",
      status.availability === "unavailable",
    );
  }
  return primitiveOnly(status);
}

/** A `requires` value this manager has no primitive for, and so cannot check. */
function unknownNeed(key: string, name: string): AccountNeed {
  return {
    key,
    name,
    state: CAPABILITY_STATE_LABELS["could-not-check"],
    tone: "unknown",
    reason: "Appflare does not know how to check this on your account.",
    fix: null,
    more: null,
  };
}

/**
 * One requirement check (`requirementChecks`, for the "Before you install"
 * banner) as the same row the app's page shows: the Workers plan, a
 * primitive, or a requirement this manager does not know.
 */
export function needOfCheck(
  check: RequirementCheck,
  app: AppNeedsOf,
  primitives: AppPrimitives,
  view: CapabilitiesView,
): AccountNeed {
  const ctx = needsContext(app, primitives, view);
  if (check.key === "plan") return planNeed(ctx);
  const primitive = requirementPrimitive(check.key);
  if (primitive !== null) return primitiveNeed(primitive, ctx);
  return unknownNeed(check.key, check.label);
}

/** Problems first, then what could not be checked, then what the admin brings, then what is ready. */
const ORDER: Record<NeedTone, number> = { missing: 0, unknown: 1, yours: 2, ready: 3 };

/**
 * Every need of the app: the Workers plan when it needs Workers Paid, each
 * primitive it uses or names in `requires`, and any `requires` value this
 * manager has no primitive for. Sorted so what stands in the way comes first.
 */
export function accountNeeds(
  app: AppNeedsOf,
  primitives: AppPrimitives,
  view: CapabilitiesView,
): AccountNeed[] {
  const ctx = needsContext(app, primitives, view);
  const needs: AccountNeed[] = [];
  if (app.plan === "paid") needs.push(planNeed(ctx));
  needs.push(...ctx.services.map((id) => primitiveNeed(id, ctx)));
  for (const requirement of app.requires) {
    if (requirementPrimitive(requirement) !== null) continue;
    needs.push(unknownNeed(requirement, requirementLabel(requirement)));
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
