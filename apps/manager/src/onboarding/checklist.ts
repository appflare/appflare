import { type IndexApp, isServiceId, requirementService, type ServiceId } from "@appflare/schema";
import { type CapabilitiesView, PLAN_LABELS, unknownSentence } from "../capabilities/capabilities";
import { dashboardUrl, zeroTrustDashboardUrl } from "../cloudflare/dashboard-links";
import { settingsLink } from "../components/settings-links";
import {
  NO_SANDBOX_JOBS,
  type SandboxJobState,
  type SandboxRowState,
  sandboxReadinessOf,
  withSandboxJobs,
} from "../sandbox/readiness";

/**
 * The onboarding checklist: what the account has that apps rely on, read from
 * the capability probes, each row Done, Needs you, or Optional, with a
 * dashboard link and one line on why it matters, counted from the cached
 * catalog. Shown as the last setup step and on Settings › Your account.
 * Pure and client-safe; the rules are tested here.
 */

export type ChecklistStatus = "done" | "needs-you" | "optional";

export type ChecklistRowId =
  | "workers-dev"
  | "workers-plan"
  | "r2"
  | "analytics-engine"
  | "zone"
  | "email-routing"
  | "zero-trust"
  | "sandbox";

export interface ChecklistLink {
  href: string;
  label: string;
  /** Opens the Cloudflare dashboard in a new tab; false for a page of this manager. */
  external: boolean;
}

/**
 * What the row offers in the app itself, rather than a link: "Enable now",
 * or the spinner of an enable in progress (its link goes to the job's log).
 */
export type ChecklistAction = "enable-sandbox" | "enabling";

export interface ChecklistRow {
  id: ChecklistRowId;
  label: string;
  status: ChecklistStatus;
  /** What the probe found, in a few words (at most about 40 characters, one line). */
  value: string;
  /**
   * More about the value for the row's help tooltip, such as the Zero Trust
   * team domain behind "Configured"; never shown in the row itself.
   */
  detail: string | null;
  /** Why it matters, with the number of catalog apps that need it when known. */
  why: string;
  /** Why the probe could not tell, when it could not. */
  note: string | null;
  link: ChecklistLink | null;
  /** Shown to admins only; a row has a link or an action, never both. */
  action: ChecklistAction | null;
}

/** A row whose only way forward is a link (every row but sandbox builds). */
type LinkRow = Omit<ChecklistRow, "action" | "detail"> & { detail?: string | null };

/** Sandbox builds as the checklist shows them: state only. */
export type SandboxBuildsState = "enabled" | "off";

/** How many catalog apps need each thing, from the cached index. */
export interface CatalogNeeds {
  total: number;
  workersPaid: number;
  r2: number;
  analyticsEngine: number;
  zone: number;
  emailRouting: number;
  access: number;
  /** Built in the account (`sandbox` and `self-deploying` tiers). */
  sandbox: number;
}

/**
 * Dashboard deep links into the account Appflare runs in (`:account`, so the
 * dashboard asks, while the id is not known). The routes are the ones
 * Cloudflare's own docs link to (cloudflare-docs `src/content/dash-routes/*.json`,
 * read 2026-09-24). The workers.dev registration page is where wrangler sends
 * people (`/<account id>/workers/onboarding`, wrangler 4.136.2).
 */
export function dashboardLinks(accountId: string | null) {
  return {
    workersAndPages: dashboardUrl(accountId, "workers-and-pages"),
    workersOnboarding: dashboardUrl(accountId, "workers/onboarding"),
    workersPlans: dashboardUrl(accountId, "workers/plans"),
    r2: dashboardUrl(accountId, "r2/overview"),
    analyticsEngine: dashboardUrl(accountId, "workers/analytics-engine"),
    domains: dashboardUrl(accountId, "domains/overview"),
    emailRouting: dashboardUrl(accountId, "email-service/routing"),
    zeroTrust: zeroTrustDashboardUrl(accountId, "home"),
    /** Account-owned tokens; a user token is edited from the profile's API Tokens page. */
    accountApiTokens: dashboardUrl(accountId, "api-tokens"),
  };
}

/** The services an index row names, falling back to its `requires` for older rows. */
function servicesOf(app: Pick<IndexApp, "services" | "requires">): Set<ServiceId> {
  if (app.services !== undefined) return new Set(app.services.filter(isServiceId));
  const out = new Set<ServiceId>();
  for (const r of app.requires) {
    const id = requirementService(r);
    if (id !== null) out.add(id);
  }
  return out;
}

export function catalogNeeds(
  apps: ReadonlyArray<Pick<IndexApp, "services" | "requires" | "plan" | "tier">>,
): CatalogNeeds {
  const needs: CatalogNeeds = {
    total: apps.length,
    workersPaid: 0,
    r2: 0,
    analyticsEngine: 0,
    zone: 0,
    emailRouting: 0,
    access: 0,
    sandbox: 0,
  };
  for (const app of apps) {
    const services = servicesOf(app);
    if (app.plan === "paid") needs.workersPaid++;
    if (services.has("r2")) needs.r2++;
    if (services.has("analytics-engine")) needs.analyticsEngine++;
    if (services.has("zone") || services.has("email-routing")) needs.zone++;
    if (services.has("email-routing")) needs.emailRouting++;
    if (services.has("access")) needs.access++;
    if (app.tier !== "artifact") needs.sandbox++;
  }
  return needs;
}

/** "3 catalog apps …" / "1 catalog app …" / "No catalog app … yet." */
function counted(n: number, singular: string, plural: string): string {
  if (n === 0) return `No catalog app ${singular} yet.`;
  return n === 1 ? `1 catalog app ${singular}.` : `${n} catalog apps ${plural}.`;
}

function why(base: string, count: string | null): string {
  return count === null ? base : `${base} ${count}`;
}

export interface ChecklistInput {
  view: CapabilitiesView;
  sandbox: SandboxBuildsState;
  /** Null when no catalog index is cached yet. */
  needs: CatalogNeeds | null;
  /** The account Appflare runs in, once known. */
  accountId: string | null;
  /** An enable in progress and the last failed one; none when left out. */
  sandboxJobs?: SandboxJobState;
}

const NOT_CHECKED = "Not checked yet";
const RECHECK_NOTE = "Choose Re-check to read it with the Cloudflare token.";

function workersDevRow({ view, needs, accountId }: ChecklistInput): LinkRow {
  const links = dashboardLinks(accountId);
  const probe = view.workersDev;
  const base = "Every app answers on its own workers.dev address unless you give it a domain.";
  const row = {
    id: "workers-dev" as const,
    label: "workers.dev subdomain",
    why: why(base, needs === null ? null : counted(needs.total, "uses it", "use it by default")),
  };
  if (probe?.state === "registered") {
    return {
      ...row,
      status: "done",
      value: `${probe.subdomain}.workers.dev`,
      note: null,
      link: { href: links.workersAndPages, label: "Workers & Pages", external: true },
    };
  }
  const register: ChecklistLink = {
    // Without the account id the registration page cannot be reached directly.
    href: accountId === null ? links.workersAndPages : links.workersOnboarding,
    label: "Register",
    external: true,
  };
  if (probe === null) {
    return { ...row, status: "needs-you", value: NOT_CHECKED, note: RECHECK_NOTE, link: register };
  }
  if (probe.state === "not-registered") {
    return { ...row, status: "needs-you", value: "None registered", note: null, link: register };
  }
  return {
    ...row,
    status: "needs-you",
    value: "Unknown",
    note: unknownSentence(probe, "workers-dev"),
    link: register,
  };
}

function planRow({ view, needs, accountId }: ChecklistInput): LinkRow {
  const { plan, source } = view.plan;
  const link: ChecklistLink = {
    href: dashboardLinks(accountId).workersPlans,
    label: "Upgrade",
    external: true,
  };
  const row = {
    id: "workers-plan" as const,
    label: "Workers plan",
    why: why(
      "Workers Paid lifts the free limits and runs containers.",
      needs === null ? null : counted(needs.workersPaid, "needs it", "need it"),
    ),
    link,
  };
  const unknownNote =
    source === "default" && view.workersPlan?.state === "unknown"
      ? unknownSentence(view.workersPlan, "plan")
      : null;
  if (plan === "paid") {
    return {
      ...row,
      status: "done",
      // A resolved paid plan is always detected or set by an admin, never the default.
      value: source === "set-by-you" ? `${PLAN_LABELS.paid} (set by you)` : PLAN_LABELS.paid,
      note: null,
    };
  }
  return {
    ...row,
    status: "optional",
    value: source === "default" ? "Not known, treated as Workers Free" : PLAN_LABELS.free,
    note: unknownNote,
  };
}

function r2Row({ view, needs, accountId }: ChecklistInput): LinkRow {
  const probe = view.r2;
  const link: ChecklistLink = {
    href: dashboardLinks(accountId).r2,
    label: "Open R2",
    external: true,
  };
  const row = {
    id: "r2" as const,
    label: "R2",
    why: why(
      "Object storage for files and uploads. Turning it on is free.",
      needs === null ? null : counted(needs.r2, "stores files in R2", "store files in R2"),
    ),
    link,
  };
  if (probe?.state === "enabled") return { ...row, status: "done", value: "Enabled", note: null };
  if (probe?.state === "not-enabled") {
    // Needed as soon as one catalog app uses it (or the catalog is not known).
    const needed = needs === null || needs.r2 > 0;
    return { ...row, status: needed ? "needs-you" : "optional", value: "Not enabled", note: null };
  }
  if (probe === null) {
    return { ...row, status: "optional", value: NOT_CHECKED, note: RECHECK_NOTE };
  }
  return { ...row, status: "optional", value: "Unknown", note: unknownSentence(probe, "r2") };
}

/**
 * Analytics Engine is off on an account until someone opens its dashboard
 * page once, and Cloudflare refuses to deploy an app that writes to it until
 * then. Optional: only the apps that use it need it.
 */
function analyticsEngineRow({ view, needs, accountId }: ChecklistInput): LinkRow {
  const probe = view.analyticsEngine;
  const row = {
    id: "analytics-engine" as const,
    label: "Analytics Engine",
    why: why(
      "Stores the events apps count and chart, such as page views and link clicks. Turning it on is free.",
      needs === null ? null : counted(needs.analyticsEngine, "writes to it", "write to it"),
    ),
    link: {
      href: dashboardLinks(accountId).analyticsEngine,
      label: "Analytics Engine",
      external: true,
    },
  };
  if (probe?.state === "enabled") {
    return { ...row, status: "done", value: "Turned on", note: null };
  }
  if (probe?.state === "not-enabled") {
    return {
      ...row,
      status: "optional",
      value: "Not turned on",
      detail: "Open Analytics Engine in the dashboard once to turn it on, then Re-check.",
      note: null,
    };
  }
  if (probe === null) {
    return { ...row, status: "optional", value: NOT_CHECKED, note: RECHECK_NOTE };
  }
  return {
    ...row,
    status: "optional",
    value: "Unknown",
    note: unknownSentence(probe, "analytics-engine"),
  };
}

function zoneRow({ view, needs, accountId }: ChecklistInput): LinkRow {
  const probe = view.zone;
  const row = {
    id: "zone" as const,
    label: "Active zone",
    why: why(
      "A domain on Cloudflare lets apps answer on your own hostnames and receive email.",
      needs === null ? null : counted(needs.zone, "needs one", "need one"),
    ),
    link: { href: dashboardLinks(accountId).domains, label: "Domains", external: true },
  };
  if (probe?.state === "available") {
    return { ...row, status: "done", value: "Active zone found", note: null };
  }
  if (probe?.state === "none") {
    return { ...row, status: "optional", value: "No active zone", note: null };
  }
  if (probe === null) {
    return { ...row, status: "optional", value: NOT_CHECKED, note: RECHECK_NOTE };
  }
  return { ...row, status: "optional", value: "Unknown", note: unknownSentence(probe, "zone") };
}

function emailRoutingRow({ view, needs, accountId }: ChecklistInput): LinkRow {
  const probe = view.emailRouting;
  const row = {
    id: "email-routing" as const,
    label: "Email Routing",
    why: why(
      "Routes a domain's mail to an app; installing such an app turns it on.",
      needs === null ? null : counted(needs.emailRouting, "uses it", "use it"),
    ),
    link: { href: dashboardLinks(accountId).emailRouting, label: "Email Routing", external: true },
  };
  if (probe?.state === "available") {
    return { ...row, status: "done", value: "Available", note: null };
  }
  if (probe?.state === "no-zone") {
    return { ...row, status: "optional", value: "Needs an active zone first", note: null };
  }
  if (probe === null) {
    return { ...row, status: "optional", value: NOT_CHECKED, note: RECHECK_NOTE };
  }
  const note =
    view.zone?.state === "unknown"
      ? "Appflare checks Email Routing on a domain of the account, and could not list the domains."
      : unknownSentence(probe, "email-routing");
  return { ...row, status: "optional", value: "Unknown", note };
}

function zeroTrustRow({ view, needs, accountId }: ChecklistInput): LinkRow {
  const probe = view.zeroTrust;
  const row = {
    id: "zero-trust" as const,
    label: "Zero Trust organization",
    why: why(
      "Cloudflare Access needs one to put a sign-in in front of Appflare or an app.",
      needs === null ? null : counted(needs.access, "uses Access", "use Access"),
    ),
    link: { href: dashboardLinks(accountId).zeroTrust, label: "Zero Trust", external: true },
  };
  if (probe?.state === "exists") {
    // The team domain goes to the tooltip: the row links to Zero Trust already.
    return {
      ...row,
      status: "done",
      value: "Configured",
      detail: `Team domain ${probe.teamDomain}.`,
      note: null,
    };
  }
  if (probe?.state === "none") {
    return { ...row, status: "optional", value: "None yet", note: null };
  }
  if (probe === null) {
    return { ...row, status: "optional", value: NOT_CHECKED, note: RECHECK_NOTE };
  }
  return {
    ...row,
    status: "optional",
    value: "Unknown",
    note: unknownSentence(probe, "zero-trust"),
  };
}

/**
 * The sandbox row's short value, what the tooltip adds, and where to fix it,
 * per readiness state. The tooltip words carry no address: the link is there.
 */
function sandboxNeeds(
  state: Exclude<SandboxRowState, "on" | "ready-auto" | "needs-permission" | "enabling">,
  accountId: string | null,
): { value: string; detail: string; link: ChecklistLink } {
  const links = dashboardLinks(accountId);
  switch (state) {
    case "needs-plan":
      return {
        value: "Needs Workers Paid",
        detail: "Builds run in Cloudflare Containers, which only Workers Paid includes.",
        link: { href: links.workersPlans, label: "Upgrade", external: true },
      };
    case "needs-r2":
      return {
        value: "Needs R2 turned on",
        detail:
          "The sandbox keeps build outputs in R2. Open R2 in the dashboard once to turn it on.",
        link: { href: links.r2, label: "Open R2", external: true },
      };
  }
}

/**
 * Sandbox builds are turned on by the first install that needs them, so the
 * row is never "needs you". Its state comes from `sandboxReadinessOf`, the
 * same reading the app page and the install start use: on; ready (with
 * "Enable now" for a faster first build once the probes confirmed Workers
 * Paid, Containers and R2); or what is missing, with where to fix it.
 */
function sandboxRow({
  view,
  needs,
  sandbox,
  sandboxJobs,
  accountId,
}: ChecklistInput): ChecklistRow {
  const row = {
    id: "sandbox" as const,
    label: "Sandbox builds",
    why: why(
      "Builds apps that have no prebuilt release inside your account, in a container.",
      needs === null ? null : counted(needs.sandbox, "is built this way", "are built this way"),
    ),
    action: null,
    detail: null,
  };
  const readiness = withSandboxJobs(
    sandboxReadinessOf(view, sandbox === "enabled"),
    sandboxJobs ?? NO_SANDBOX_JOBS,
  );
  const failure = readiness.failure;
  switch (readiness.state) {
    case "on":
      return { ...row, status: "done", value: "Enabled", note: null, link: null };
    case "enabling":
      return {
        ...row,
        status: "optional",
        value: "Being turned on",
        detail: "This takes about two minutes; you can go on meanwhile.",
        note: null,
        link: { href: `/jobs/${readiness.jobId}`, label: "Enabling…", external: false },
        action: "enabling",
      };
    case "ready-auto":
      if (failure !== undefined) {
        // Ready again, but the last try failed: its log says why. The next
        // install that needs it tries again.
        return {
          ...row,
          status: "optional",
          value: "Last try failed",
          detail: `${failure.message} The next app that needs it tries again.`,
          note: null,
          link: { href: `/jobs/${failure.id}`, label: "View log", external: false },
        };
      }
      return {
        ...row,
        status: "optional",
        value: "Ready, turns on when an app needs it",
        detail: "Enabled automatically the first time an install or build needs it.",
        // Not confirmed: a probe has not run or could not tell; the start asks again.
        note: readiness.confirmed ? null : RECHECK_NOTE,
        link: null,
        action: readiness.confirmed ? "enable-sandbox" : null,
      };
    case "needs-permission":
      // The token lacks Containers: Edit or R2 access; the reason names which (no address).
      return {
        ...row,
        status: "optional",
        value: "Needs a token permission",
        detail: readiness.missing,
        note: null,
        link: {
          href: dashboardLinks(accountId).accountApiTokens,
          label: "Edit token",
          external: true,
        },
      };
    default: {
      const { value, detail, link } = sandboxNeeds(readiness.state, accountId);
      return { ...row, status: "optional", value, detail, note: null, link };
    }
  }
}

/** The rows, in a fixed order; {@link groupChecklist} arranges them for display. */
export function buildChecklist(input: ChecklistInput): ChecklistRow[] {
  const rows: Array<LinkRow & { action?: ChecklistAction | null }> = [
    workersDevRow(input),
    planRow(input),
    r2Row(input),
    analyticsEngineRow(input),
    zoneRow(input),
    emailRoutingRow(input),
    zeroTrustRow(input),
    sandboxRow(input),
  ];
  return rows.map((row) => ({ ...row, action: row.action ?? null, detail: row.detail ?? null }));
}

export const STATUS_LABELS: Record<ChecklistStatus, string> = {
  done: "Done",
  "needs-you": "Needs you",
  optional: "Optional",
};

/** How many rows need the admin. */
export function needsYouCount(rows: readonly ChecklistRow[]): number {
  return rows.filter((r) => r.status === "needs-you").length;
}

/**
 * The progress the checklist shows: rows done out of the rows that count.
 * Optional rows that are not done unlock more apps but never hold setup
 * back, so they are left out of both numbers.
 */
export function checklistProgress(rows: readonly ChecklistRow[]): { done: number; total: number } {
  const done = rows.filter((r) => r.status === "done").length;
  return { done, total: done + needsYouCount(rows) };
}

/**
 * The display order: rows that need the admin first (expanded), then the
 * done ones (one line each), then the optional ones (secondary). Each group
 * keeps the fixed row order.
 */
export function groupChecklist(rows: readonly ChecklistRow[]): {
  needsYou: ChecklistRow[];
  done: ChecklistRow[];
  optional: ChecklistRow[];
} {
  return {
    needsYou: rows.filter((r) => r.status === "needs-you"),
    done: rows.filter((r) => r.status === "done"),
    optional: rows.filter((r) => r.status === "optional"),
  };
}

/** The account checklist's Analytics Engine row, where a refused install points. */
export const ANALYTICS_ENGINE_CHECKLIST_LINK: ChecklistLink = {
  href: settingsLink("account", "capability-analytics-engine"),
  label: "Analytics Engine in the account checklist",
  external: false,
};

/**
 * The element id of a row, so other pages can link to it (the sandbox row is
 * `capability-sandbox`, where a refused install points).
 */
export function checklistRowAnchor(row: Pick<ChecklistRow, "id">): string {
  return `capability-${row.id}`;
}

/**
 * The row's help tooltip, after its value: what the value stands for, why the
 * probe could not tell (when it could not), and why the row matters.
 */
export function rowHelp(row: ChecklistRow): string {
  return [row.detail, row.note, row.why].filter((part) => part !== null).join(" ");
}

/** The longest value a row shows; longer ones would wrap or hide behind an ellipsis. */
export const MAX_ROW_VALUE_LENGTH = 40;
