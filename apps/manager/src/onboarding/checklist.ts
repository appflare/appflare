import { type IndexApp, isServiceId, requirementService, type ServiceId } from "@appflare/schema";
import { type CapabilitiesView, PLAN_LABELS, unknownSentence } from "../capabilities/capabilities";

/**
 * The onboarding checklist: what the account has that apps rely on, read from
 * the capability probes, each row Done, Needs you, or Optional, with a
 * dashboard link and one line on why it matters, counted from the cached
 * catalog. Shown as the last setup step and on Settings › Account and
 * capabilities. Pure and client-safe; the rules are tested here.
 */

export type ChecklistStatus = "done" | "needs-you" | "optional";

export type ChecklistRowId =
  | "workers-dev"
  | "workers-plan"
  | "r2"
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

export interface ChecklistRow {
  id: ChecklistRowId;
  label: string;
  status: ChecklistStatus;
  /** What the probe found, in a few words. */
  value: string;
  /** Why it matters, with the number of catalog apps that need it when known. */
  why: string;
  /** Why the probe could not tell, when it could not. */
  note: string | null;
  link: ChecklistLink | null;
}

/** Sandbox builds as the checklist shows them: state only. */
export type SandboxBuildsState = "enabled" | "off";

/** How many catalog apps need each thing, from the cached index. */
export interface CatalogNeeds {
  total: number;
  workersPaid: number;
  r2: number;
  zone: number;
  emailRouting: number;
  access: number;
  /** Built in the account (`sandbox` and `self-deploying` tiers). */
  sandbox: number;
}

const DASH = "https://dash.cloudflare.com";

/**
 * Dashboard deep links. `?to=/:account/...` routes are the ones Cloudflare's
 * own docs link to (cloudflare-docs `src/content/dash-routes/*.json`, read
 * 2026-09-24); the dashboard asks which account when there are several. The
 * workers.dev registration page is where wrangler sends people
 * (`/<account id>/workers/onboarding`, wrangler 4.136.2).
 */
export const DASHBOARD_LINKS = {
  workersAndPages: `${DASH}/?to=/:account/workers-and-pages`,
  workersOnboarding: (accountId: string) => `${DASH}/${accountId}/workers/onboarding`,
  workersPlans: `${DASH}/?to=/:account/workers/plans`,
  r2: `${DASH}/?to=/:account/r2/overview`,
  domains: `${DASH}/?to=/:account/domains/overview`,
  emailRouting: `${DASH}/?to=/:account/email-service/routing`,
  zeroTrust: "https://one.dash.cloudflare.com/?to=/:account/home",
} as const;

/** The in-app page that holds the sandbox builds card and this checklist. */
export const ACCOUNT_SETTINGS_PATH = "/settings/account";

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
    zone: 0,
    emailRouting: 0,
    access: 0,
    sandbox: 0,
  };
  for (const app of apps) {
    const services = servicesOf(app);
    if (app.plan === "paid") needs.workersPaid++;
    if (services.has("r2")) needs.r2++;
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
  /** Leave out links to the page the checklist is already on. */
  onAccountSettings?: boolean;
}

const NOT_CHECKED = "Not checked yet";
const RECHECK_NOTE = "Choose Re-check to read it with the Cloudflare token.";

function workersDevRow({ view, needs, accountId }: ChecklistInput): ChecklistRow {
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
      link: { href: DASHBOARD_LINKS.workersAndPages, label: "Workers & Pages", external: true },
    };
  }
  const register: ChecklistLink = {
    href:
      accountId === null
        ? DASHBOARD_LINKS.workersAndPages
        : DASHBOARD_LINKS.workersOnboarding(accountId),
    label: "Register a subdomain",
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

function planRow({ view, needs }: ChecklistInput): ChecklistRow {
  const { plan, source } = view.plan;
  const link: ChecklistLink = {
    href: DASHBOARD_LINKS.workersPlans,
    label: "Workers plans",
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

function r2Row({ view, needs }: ChecklistInput): ChecklistRow {
  const probe = view.r2;
  const link: ChecklistLink = { href: DASHBOARD_LINKS.r2, label: "R2", external: true };
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

function zoneRow({ view, needs }: ChecklistInput): ChecklistRow {
  const probe = view.zone;
  const row = {
    id: "zone" as const,
    label: "Active zone",
    why: why(
      "A domain on Cloudflare lets apps answer on your own hostnames and receive email.",
      needs === null ? null : counted(needs.zone, "needs one", "need one"),
    ),
    link: { href: DASHBOARD_LINKS.domains, label: "Domains", external: true },
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

function emailRoutingRow({ view, needs }: ChecklistInput): ChecklistRow {
  const probe = view.emailRouting;
  const row = {
    id: "email-routing" as const,
    label: "Email Routing",
    why: why(
      "Routes a domain's mail to an app; installing such an app turns it on.",
      needs === null ? null : counted(needs.emailRouting, "uses it", "use it"),
    ),
    link: { href: DASHBOARD_LINKS.emailRouting, label: "Email Routing", external: true },
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

function zeroTrustRow({ view, needs }: ChecklistInput): ChecklistRow {
  const probe = view.zeroTrust;
  const row = {
    id: "zero-trust" as const,
    label: "Zero Trust organization",
    why: why(
      "Cloudflare Access needs one to put a sign-in in front of Appflare or an app.",
      needs === null ? null : counted(needs.access, "uses Access", "use Access"),
    ),
    link: { href: DASHBOARD_LINKS.zeroTrust, label: "Zero Trust", external: true },
  };
  if (probe?.state === "exists") {
    return { ...row, status: "done", value: probe.teamDomain, note: null };
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

function sandboxRow({ view, needs, sandbox, onAccountSettings }: ChecklistInput): ChecklistRow {
  const row = {
    id: "sandbox" as const,
    label: "Sandbox builds",
    why: why(
      "Builds apps that have no prebuilt release inside your account, in a container.",
      needs === null ? null : counted(needs.sandbox, "is built this way", "are built this way"),
    ),
  };
  if (sandbox === "enabled") {
    return { ...row, status: "done", value: "Enabled", note: null, link: null };
  }
  if (view.plan.plan !== "paid") {
    return {
      ...row,
      status: "optional",
      value: "Needs Workers Paid",
      note: null,
      link: { href: DASHBOARD_LINKS.workersPlans, label: "Workers plans", external: true },
    };
  }
  return {
    ...row,
    status: "optional",
    value: "Off",
    note: null,
    link:
      onAccountSettings === true
        ? null
        : { href: ACCOUNT_SETTINGS_PATH, label: "Sandbox builds settings", external: false },
  };
}

/** The rows, in the order the checklist shows them. */
export function buildChecklist(input: ChecklistInput): ChecklistRow[] {
  return [
    workersDevRow(input),
    planRow(input),
    r2Row(input),
    zoneRow(input),
    emailRoutingRow(input),
    zeroTrustRow(input),
    sandboxRow(input),
  ];
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
