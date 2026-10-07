import {
  type AccessServiceTokensCapability,
  type AccountCapabilities,
  type AccountSetupCapabilities,
  type AnalyticsEngineCapability,
  type CapabilityUnknown,
  type ContainersCapability,
  type DomainCapabilities,
  detectedWorkersPlan,
  type EmailRoutingCapability,
  type R2Capability,
  type WorkersDevCapability,
  type WorkersPlanCapability,
  type ZeroTrustCapability,
  type ZoneCapability,
} from "@appflare/cf-api/capabilities";
import { z } from "zod";
import { type AccountPlan, parseAccountPlan } from "../account/plan";
import { isUpdateAvailable } from "../catalog/versions";
import type { ConnectionKind } from "../cloudflare/connection-view";

/**
 * Account capabilities as the manager keeps them: what the probes in
 * `@appflare/cf-api/capabilities` last found (R2 enabled, Containers
 * available, Workers plan, a zone the token can see, Email Routing on it,
 * Analytics Engine turned on),
 * when, and the Workers plan every confirmation reads: the detected one
 * first, then the one an admin set. Client-safe: the Settings card and the
 * catalog page use the same words.
 */

const unknownSchema = z.object({
  state: z.literal("unknown"),
  reason: z.enum(["no-permission", "unrecognised", "error"]),
  detail: z.string(),
});

/** The `account_capabilities` settings row. */
export const storedCapabilitiesSchema = z.object({
  /** ISO 8601 time of the probes. */
  checkedAt: z.string(),
  /**
   * The Appflare version that ran the probes. Absent in rows written before
   * it was recorded; a row of an older version is checked again (`capabilitiesStaleness`).
   */
  version: z.string().optional(),
  r2: z.union([z.object({ state: z.enum(["enabled", "not-enabled"]) }), unknownSchema]),
  containers: z.union([
    z.object({ state: z.enum(["available", "needs-workers-paid"]) }),
    unknownSchema,
  ]),
  workersPlan: z.union([z.object({ state: z.enum(["paid", "free"]) }), unknownSchema]),
  // Absent in rows written before the domain probes existed: not checked yet.
  zone: z.union([z.object({ state: z.enum(["available", "none"]) }), unknownSchema]).optional(),
  emailRouting: z
    .union([z.object({ state: z.enum(["available", "no-zone"]) }), unknownSchema])
    .optional(),
  // Absent in rows written before the workers.dev and Zero Trust probes existed.
  workersDev: z
    .union([
      z.object({ state: z.literal("registered"), subdomain: z.string().min(1) }),
      z.object({ state: z.literal("not-registered") }),
      unknownSchema,
    ])
    .optional(),
  zeroTrust: z
    .union([
      z.object({ state: z.literal("exists"), teamDomain: z.string().min(1) }),
      z.object({ state: z.literal("none") }),
      unknownSchema,
    ])
    .optional(),
  // Absent in rows written before the Analytics Engine probe existed.
  analyticsEngine: z
    .union([z.object({ state: z.enum(["enabled", "not-enabled"]) }), unknownSchema])
    .optional(),
  // Absent in rows written before the Access service token probe existed.
  accessServiceTokens: z
    .union([z.object({ state: z.literal("readable") }), unknownSchema])
    .optional(),
});
export type StoredCapabilities = AccountCapabilities &
  Partial<DomainCapabilities> &
  Partial<AccountSetupCapabilities> & { checkedAt: string; version?: string };

/**
 * Every probe this version runs, so a row that lacks one is known to come
 * from an older version. The record type makes adding a probe without
 * listing it here a type error.
 */
const PROBES: Record<Exclude<keyof StoredCapabilities, "checkedAt" | "version">, true> = {
  r2: true,
  containers: true,
  workersPlan: true,
  zone: true,
  emailRouting: true,
  workersDev: true,
  zeroTrust: true,
  analyticsEngine: true,
  accessServiceTokens: true,
};

/**
 * Why the stored probes should run again, or null while they hold: never
 * run; run by an older Appflare version, or one that did not record its
 * own (Appflare was updated since, and the new version may probe more or
 * read an answer differently); missing a probe this version runs; or run
 * on an earlier UTC day. A newer version's answer holds until the next day:
 * while a self-update checks its new version, both versions serve, and
 * neither should probe again because the other just did. Without `version`
 * the version is not compared.
 */
export type CapabilitiesStaleness =
  | "never-checked"
  | "older-version"
  | "missing-probe"
  | "earlier-day";

export function capabilitiesStaleness(
  stored: StoredCapabilities | null,
  current: { now: Date; version?: string },
): CapabilitiesStaleness | null {
  if (stored === null) return "never-checked";
  if (
    current.version !== undefined &&
    (stored.version === undefined || isUpdateAvailable(stored.version, current.version))
  ) {
    return "older-version";
  }
  const probes = Object.keys(PROBES) as (keyof typeof PROBES)[];
  if (probes.some((probe) => stored[probe] === undefined)) return "missing-probe";
  if (stored.checkedAt.slice(0, 10) !== current.now.toISOString().slice(0, 10)) {
    return "earlier-day";
  }
  return null;
}

/** The stored row, or null when it is absent or unreadable (then nothing counts as detected). */
export function parseStoredCapabilities(
  value: string | null | undefined,
): StoredCapabilities | null {
  if (!value) return null;
  try {
    const parsed = storedCapabilitiesSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Where the Workers plan in force comes from. */
export type AccountPlanSource = "detected" | "set-by-you" | "default";

export interface ResolvedAccountPlan {
  plan: AccountPlan;
  source: AccountPlanSource;
}

/**
 * The Workers plan every paid-app confirmation and the cron-trigger count
 * read: what the probes detected, else what an admin set in Settings, else
 * free.
 */
export function resolveAccountPlan(
  manual: string | null | undefined,
  stored: StoredCapabilities | null,
): ResolvedAccountPlan {
  const detected = stored === null ? null : detectedWorkersPlan(stored);
  if (detected !== null) return { plan: detected, source: "detected" };
  if (manual === "free" || manual === "paid") {
    return { plan: parseAccountPlan(manual), source: "set-by-you" };
  }
  return { plan: "free", source: "default" };
}

/** What Settings and the catalog page show. */
export interface CapabilitiesView {
  /** Null until the probes have run once. */
  checkedAt: string | null;
  r2: R2Capability | null;
  containers: ContainersCapability | null;
  workersPlan: WorkersPlanCapability | null;
  /** Null until the domain probes have run once. */
  zone: ZoneCapability | null;
  emailRouting: EmailRoutingCapability | null;
  /** Null until the onboarding probes have run once. */
  workersDev: WorkersDevCapability | null;
  zeroTrust: ZeroTrustCapability | null;
  /** Null until the Analytics Engine probe has run once. */
  analyticsEngine: AnalyticsEngineCapability | null;
  /** Whether the token can read Access service tokens (Read, not Edit); null until probed once. */
  accessServiceTokens: AccessServiceTokensCapability | null;
  /** The plan in force and where it comes from. */
  plan: ResolvedAccountPlan;
  /** The plan an admin set in Settings, used when none is detected. */
  manualPlan: AccountPlan | null;
  /** The account Appflare runs in, for dashboard links; null before a token is saved. */
  accountId: string | null;
  /**
   * How Appflare connects to Cloudflare: what to do about a refused
   * permission depends on it (a token is edited, a sign-in is done again).
   */
  connection: ConnectionKind;
}

export function capabilitiesView(
  manual: string | null | undefined,
  stored: StoredCapabilities | null,
  accountId: string | null | undefined = null,
  connection: ConnectionKind = "api_token",
): CapabilitiesView {
  return {
    checkedAt: stored?.checkedAt ?? null,
    r2: stored?.r2 ?? null,
    containers: stored?.containers ?? null,
    workersPlan: stored?.workersPlan ?? null,
    zone: stored?.zone ?? null,
    emailRouting: stored?.emailRouting ?? null,
    workersDev: stored?.workersDev ?? null,
    zeroTrust: stored?.zeroTrust ?? null,
    analyticsEngine: stored?.analyticsEngine ?? null,
    accessServiceTokens: stored?.accessServiceTokens ?? null,
    plan: resolveAccountPlan(manual, stored),
    manualPlan: manual === "free" || manual === "paid" ? manual : null,
    accountId: accountId || null,
    connection,
  };
}

/** Whether Settings offers the manual Workers plan choice, and why it is there. */
export type ManualPlanControl =
  | { show: false }
  | {
      show: true;
      /**
       * Whether the token lacks Billing: Read (or the probes have not run
       * yet), so adding that permission would make the choice unnecessary.
       * False when the token can read the subscriptions but they do not name
       * a Workers plan, such as a contract plan.
       */
      billingHint: boolean;
    };

/**
 * The manual Workers plan choice is only a fallback: hidden while the plan is
 * detected (a choice there would change nothing), shown otherwise.
 */
export function manualPlanControl(
  view: CapabilitiesView,
  /** Cloudflare sign-in has no permission for the plan, so no hint helps then. */
  connection: ConnectionKind = "api_token",
): ManualPlanControl {
  if (view.plan.source === "detected") return { show: false };
  const plan = view.workersPlan;
  return {
    show: true,
    billingHint:
      connection === "api_token" &&
      (plan === null || (plan.state === "unknown" && plan.reason === "no-permission")),
  };
}

export const PLAN_LABELS: Record<AccountPlan, string> = {
  free: "Workers Free",
  paid: "Workers Paid",
};

/** The source words next to every value. */
export const SOURCE_LABELS = {
  detected: "Detected",
  "set-by-you": "Set by you",
} as const satisfies Record<Exclude<AccountPlanSource, "default">, string>;

/**
 * The Workers plan over Cloudflare sign-in, which has no permission for it
 * (Cloudflare's sign-in scopes include no Billing one): asked once, unless
 * Containers answer, which only Workers Paid has.
 */
export const SIGN_IN_PLAN_COPY = {
  ask: "Cloudflare sign-in cannot share the account's Workers plan with Appflare, so choose it once here. If the account can use Containers, Appflare counts it as Workers Paid by itself.",
  chosen:
    "Cloudflare sign-in cannot share the account's Workers plan with Appflare, so Appflare uses the one you chose. If the account can use Containers, Appflare counts it as Workers Paid by itself.",
} as const;

/** Why a probe could not tell, in one sentence. */
export function unknownSentence(
  value: CapabilityUnknown,
  what:
    | "r2"
    | "containers"
    | "plan"
    | "zone"
    | "email-routing"
    | "workers-dev"
    | "zero-trust"
    | "analytics-engine",
  /** How Appflare connects: a token is edited in the dashboard, a sign-in is done again. */
  connection: ConnectionKind = "api_token",
): string {
  if (value.reason === "no-permission" && connection === "oauth") {
    if (what === "plan") return SIGN_IN_PLAN_COPY.ask;
    if (what === "analytics-engine") {
      return "Cloudflare refused Appflare's Analytics Engine query, so Appflare cannot tell whether it is on.";
    }
    return "Cloudflare did not let Appflare read this with its sign-in. Reconnect Cloudflare and allow every permission Appflare asks for.";
  }
  if (value.reason === "no-permission") {
    return {
      "workers-dev":
        "The token cannot read the account's workers.dev subdomain (Workers Scripts permission).",
      "zero-trust":
        'The token cannot read the Zero Trust organization. Add the optional "Access: Organizations, Identity Providers, and Groups" permission.',
      r2: "The token cannot list R2 buckets (Workers R2 Storage).",
      containers:
        "The token has no Containers permission, so Appflare cannot check. Workers Paid includes Containers.",
      plan: 'The token cannot read the account\'s subscriptions. Add the optional "Billing: Read" permission to detect the plan.',
      zone: 'The token cannot list the account\'s domains. Add the optional "Zone: Read" permission.',
      "email-routing":
        'The token cannot read Email Routing on the account\'s domain. Add the optional "Zone Settings" permission.',
      "analytics-engine":
        "Cloudflare refused the token's Analytics Engine query, so Appflare cannot tell whether it is on.",
    }[what];
  }
  if (value.reason === "unrecognised") {
    return "Cloudflare's answer did not say which Workers plan applies (for example a contract plan).";
  }
  return `The check failed: ${value.detail}`;
}

/** A value with its tone, as the badge next to a requirement shows it. */
export interface CapabilityBadge {
  met: boolean;
  label: string;
}

function planBadgeOf({ plan, source }: ResolvedAccountPlan): CapabilityBadge | null {
  if (source === "default") return null;
  if (plan === "paid") return { met: true, label: `${SOURCE_LABELS[source]}: Workers Paid` };
  // An admin's "free" is only the fallback they chose; Cloudflare saying so is news.
  return source === "detected" ? { met: false, label: "Detected: Workers Free" } : null;
}

/** For an app that needs Workers Paid: what the account's plan says. */
export function paidPlanBadge(view: CapabilitiesView): CapabilityBadge | null {
  return planBadgeOf(view.plan);
}

/**
 * For one catalog `requires` value: what the probes found, or null when they
 * found nothing to say (the requirement then stays for the admin to confirm).
 * Containers fall back to the Workers plan, which is what they need.
 */
export function requirementBadge(
  requirement: string,
  view: CapabilitiesView,
): CapabilityBadge | null {
  if (requirement === "r2") {
    if (view.r2?.state === "enabled") return { met: true, label: "Detected: enabled" };
    if (view.r2?.state === "not-enabled") return { met: false, label: "Detected: not enabled" };
    return null;
  }
  if (requirement === "containers") {
    if (view.containers?.state === "available") return { met: true, label: "Detected: available" };
    if (view.containers?.state === "needs-workers-paid") {
      return { met: false, label: "Detected: needs Workers Paid" };
    }
    return planBadgeOf(view.plan);
  }
  if (requirement === "zone") {
    if (view.zone?.state === "available")
      return { met: true, label: "Detected: active zone found" };
    if (view.zone?.state === "none") return { met: false, label: "Detected: no active zone" };
    return null;
  }
  if (requirement === "email-routing") {
    const state = view.emailRouting?.state;
    if (state === "available") return { met: true, label: "Detected: available" };
    if (state === "no-zone") return { met: false, label: "Detected: no active zone" };
    return null;
  }
  if (requirement === "analytics-engine") {
    const state = view.analyticsEngine?.state;
    if (state === "enabled") return { met: true, label: "Detected: turned on" };
    if (state === "not-enabled") return { met: false, label: "Detected: not turned on" };
    return null;
  }
  return null;
}
