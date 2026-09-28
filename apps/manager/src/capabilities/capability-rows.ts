import type { CapabilityUnknown } from "@appflare/cf-api/capabilities";
import { type IndexApp, isServiceId, type ServiceId } from "@appflare/schema";
import { dashboardLinks } from "../cloudflare/dashboard-links";
import { settingsLink } from "../components/settings-links";
import {
  NO_SANDBOX_JOBS,
  type SandboxJobState,
  sandboxReadinessOf,
  withSandboxJobs,
} from "../sandbox/readiness";
import { type CapabilitiesView, PLAN_LABELS, unknownSentence } from "./capabilities";

/**
 * "What this account can run": one row per thing apps rely on in the
 * Cloudflare account (the Workers plan, a workers.dev address, R2, a
 * domain, Email Routing, Analytics Engine, Zero Trust, sandbox builds and
 * the token's permissions), read from the stored capability probes. Each row
 * has a name, one sentence on why apps need it, a state (Ready, Needs
 * action, Not set up, Paid plan only, Could not check), at most one action, and the
 * details shown on demand: what was found and by whom, when, what went
 * wrong, how many catalog apps use it. The same rows appear in the last
 * setup step and on Your account. Pure and client-safe; the rules are
 * tested here.
 */

export type CapabilityId =
  | "workers-plan"
  | "workers-dev"
  | "r2"
  | "zone"
  | "email-routing"
  | "analytics-engine"
  | "zero-trust"
  | "sandbox"
  | "token-permissions";

/**
 * `needs-action` only when an app in the account (installed, being
 * installed, or about to be) needs what is missing; `not-set-up` when it is
 * off and nothing there needs it yet.
 */
export type CapabilityState =
  | "ready"
  | "needs-action"
  | "not-set-up"
  | "paid-only"
  | "could-not-check";

export const CAPABILITY_STATE_LABELS: Record<CapabilityState, string> = {
  ready: "Ready",
  "needs-action": "Needs action",
  "not-set-up": "Not set up",
  "paid-only": "Paid plan only",
  "could-not-check": "Could not check",
};

/**
 * The row's one action: a page of the Cloudflare dashboard where it is
 * turned on, where a domain is added, or where the token is edited; the
 * Workers plan an admin states while Appflare cannot detect it; or the
 * Building apps settings for sandbox builds.
 */
export type CapabilityAction =
  | { kind: "turn-on"; label: "Turn on in Cloudflare"; href: string }
  | { kind: "add-domain"; label: "Add a domain in Cloudflare"; href: string }
  | { kind: "edit-token"; label: "Edit token in Cloudflare"; href: string }
  | { kind: "choose-plan"; label: "Choose plan" }
  | { kind: "set-up"; label: "Set up"; href: string };

/** Where a row's state came from: Appflare's own check, or an admin's statement. */
export type CapabilitySource = "detected" | "set-by-you";

export interface CapabilityDetails {
  /** What the check found, in a few plain words ("Workers Free"); null when it found nothing. */
  found: string | null;
  source: CapabilitySource | null;
  /** When the probes last ran (ISO 8601); null before they ever did. */
  checkedAt: string | null;
  /**
   * Why the check could not tell, or what stands in the way, in a sentence.
   * May carry a link to a page of the manager (`message-links.ts`).
   */
  problem: string | null;
  /** Anything else worth knowing, such as optional permissions not granted. */
  note: string | null;
  /** How many catalog apps use it; null when no catalog is cached yet. */
  usedBy: string | null;
  /** A job behind the state: an enable in progress, or the last one that failed. */
  job: { href: string; label: string } | null;
}

export interface CapabilityRow {
  id: CapabilityId;
  name: string;
  /** One sentence on why apps need it. */
  why: string;
  state: CapabilityState;
  action: CapabilityAction | null;
  details: CapabilityDetails;
}

/** Whether this manager has its sandbox Worker connected. */
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

export interface CapabilityRowsInput {
  view: CapabilitiesView;
  sandbox: SandboxBuildsState;
  /** What the catalog's apps need; null when no catalog index is cached yet. */
  needs: CatalogNeeds | null;
  /**
   * What the apps in the account need: installed ones, ones being installed
   * or updated, and an app about to be installed. What they need and the
   * account lacks is "Needs action"; anything else that is off is "Not set
   * up". Nothing counts as needed when left out.
   */
  inUse?: CatalogNeeds | null;
  /** An enable in progress and the last failed sandbox job; none when left out. */
  sandboxJobs?: SandboxJobState;
}

/** The services an index row names that this version knows. */
function servicesOf(app: Pick<IndexApp, "services">): Set<ServiceId> {
  return new Set(app.services.filter(isServiceId));
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

/** What an install records: its app, the catalog listing it, and where its code comes from. */
export interface InstallOfApp {
  appSlug: string;
  /** Null for the official catalog, and for an install from a repository. */
  catalogId: string | null;
  origin: "catalog" | "repository" | "source";
}

type NeedsOfApp = Pick<IndexApp, "services" | "requires" | "plan" | "tier">;

/** An app built from a repository: it is built in the account's sandbox. */
const BUILT_FROM_SOURCE: NeedsOfApp = { requires: [], services: [], plan: "paid", tier: "sandbox" };

/**
 * What the apps in the account need, from their catalog entries (`find`
 * returns the entry an install came from, or undefined when no cached
 * catalog lists it any more). An install built from a repository needs
 * sandbox builds.
 */
export function installedNeeds(
  installs: readonly InstallOfApp[],
  find: (install: InstallOfApp) => NeedsOfApp | undefined,
): CatalogNeeds {
  const apps = installs.flatMap((install): NeedsOfApp[] => {
    if (install.origin !== "catalog") return [BUILT_FROM_SOURCE];
    const app = find(install);
    return app === undefined ? [] : [app];
  });
  return catalogNeeds(apps);
}

/** "3 catalog apps use it." / "1 catalog app uses it." / "No catalog app uses it yet." */
function usedBy(needs: CatalogNeeds | null, pick: (n: CatalogNeeds) => number): string | null {
  if (needs === null) return null;
  const n = pick(needs);
  if (n === 0) return "No catalog app uses it yet.";
  return n === 1 ? "1 catalog app uses it." : `${n} catalog apps use it.`;
}

const NOT_CHECKED = "Not checked yet.";

type Probe = { state: string } | null;

function isUnknown(probe: Probe): probe is CapabilityUnknown {
  return probe !== null && probe.state === "unknown";
}

/** The details every row starts from: when the probes ran, and nothing found yet. */
function details(view: CapabilitiesView, over: Partial<CapabilityDetails>): CapabilityDetails {
  return {
    found: null,
    source: null,
    checkedAt: view.checkedAt,
    problem: null,
    note: null,
    usedBy: null,
    job: null,
    ...over,
  };
}

/** Whether an app in the account needs what `pick` counts. */
function inUse(input: CapabilityRowsInput, pick: (n: CatalogNeeds) => number): boolean {
  return input.inUse !== undefined && input.inUse !== null && pick(input.inUse) > 0;
}

function turnOn(href: string): CapabilityAction {
  return { kind: "turn-on", label: "Turn on in Cloudflare", href };
}

/** A domain is added, not turned on: the dashboard page where one is added. */
function addDomain(href: string): CapabilityAction {
  return { kind: "add-domain", label: "Add a domain in Cloudflare", href };
}

const CHOOSE_PLAN: CapabilityAction = { kind: "choose-plan", label: "Choose plan" };

const SET_UP_SANDBOX: CapabilityAction = {
  kind: "set-up",
  label: "Set up",
  href: settingsLink("building", "sandbox"),
};

/**
 * A row read from one probe: ready by what it found, else "Needs action"
 * when an app in the account needs it (`needed`) and "Not set up" when
 * nothing does, both with the dashboard page that turns it on; or "Could
 * not check" (with the reason, and no button: Check again is the way on)
 * when it has not run or could not tell.
 */
function probeRow<P extends Probe>(
  input: CapabilityRowsInput,
  row: {
    id: CapabilityId;
    name: string;
    why: string;
    usedBy: string | null;
    /** An app in the account needs it. */
    needed: boolean;
  },
  probe: P,
  read: (probe: Exclude<P, CapabilityUnknown | null>) => {
    ready: boolean;
    found: string;
    problem?: string | null;
    note?: string | null;
  },
  fix: CapabilityAction,
  unknownProblem: (probe: CapabilityUnknown) => string,
): CapabilityRow {
  const { view } = input;
  const base = { id: row.id, name: row.name, why: row.why };
  if (probe === null) {
    return {
      ...base,
      state: "could-not-check",
      action: null,
      details: details(view, { problem: NOT_CHECKED, usedBy: row.usedBy }),
    };
  }
  if (isUnknown(probe)) {
    return {
      ...base,
      state: "could-not-check",
      action: null,
      details: details(view, { problem: unknownProblem(probe), usedBy: row.usedBy }),
    };
  }
  const reading = read(probe as Exclude<P, CapabilityUnknown | null>);
  return {
    ...base,
    state: reading.ready ? "ready" : row.needed ? "needs-action" : "not-set-up",
    action: reading.ready ? null : fix,
    details: details(view, {
      found: reading.found,
      source: "detected",
      problem: reading.problem ?? null,
      note: reading.note ?? null,
      usedBy: row.usedBy,
    }),
  };
}

/**
 * The Workers plan: ready once it is known, detected or stated by an admin.
 * "Choose plan" is offered whenever Appflare cannot detect it.
 */
function planRow({ view, needs }: CapabilityRowsInput): CapabilityRow {
  const { plan, source } = view.plan;
  const base = {
    id: "workers-plan" as const,
    name: "Workers plan",
    why: "Some apps need Workers Paid, which lifts the free plan's limits and runs containers.",
  };
  const used = usedBy(needs, (n) => n.workersPaid);
  const probe = view.workersPlan;
  // Why the plan is not detected: the probe's own sentence, or not checked yet.
  const problem =
    source === "detected"
      ? null
      : probe === null
        ? NOT_CHECKED
        : isUnknown(probe)
          ? unknownSentence(probe, "plan")
          : null;
  if (source !== "default") {
    return {
      ...base,
      state: "ready",
      action: source === "set-by-you" ? CHOOSE_PLAN : null,
      details: details(view, {
        found: PLAN_LABELS[plan],
        source,
        // A stated plan is fine as it is; why it is not detected is only a note.
        note: problem,
        usedBy: used,
      }),
    };
  }
  // Not known: an admin states it. A check that failed outright (or never
  // ran) could not tell; one that cannot read the plan at all needs the admin.
  const couldNotCheck = probe === null || (isUnknown(probe) && probe.reason === "error");
  return {
    ...base,
    state: couldNotCheck ? "could-not-check" : "needs-action",
    action: CHOOSE_PLAN,
    details: details(view, {
      found: "Not known, treated as Workers Free",
      problem,
      usedBy: used,
    }),
  };
}

function workersDevRow(input: CapabilityRowsInput): CapabilityRow {
  const links = dashboardLinks(input.view.accountId);
  return probeRow(
    input,
    {
      id: "workers-dev",
      name: "workers.dev address",
      why: "Every app gets its own workers.dev address unless you give it a domain.",
      usedBy: usedBy(input.needs, (n) => n.total),
      // Every app answers on it until it has a domain.
      needed: true,
    },
    input.view.workersDev,
    (probe) =>
      probe.state === "registered"
        ? { ready: true, found: `${probe.subdomain}.workers.dev` }
        : { ready: false, found: "No address registered" },
    // Without the account id the registration page cannot be reached directly.
    turnOn(input.view.accountId === null ? links.workersAndPages : links.workersOnboarding),
    (probe) => unknownSentence(probe, "workers-dev"),
  );
}

function r2Row(input: CapabilityRowsInput): CapabilityRow {
  return probeRow(
    input,
    {
      id: "r2",
      name: "R2 storage",
      why: "Apps keep files and uploads in R2. Turning it on is free.",
      usedBy: usedBy(input.needs, (n) => n.r2),
      needed: inUse(input, (n) => n.r2),
    },
    input.view.r2,
    (probe) =>
      probe.state === "enabled"
        ? { ready: true, found: "Turned on" }
        : {
            ready: false,
            found: "Not turned on",
            note: "Cloudflare asks for a payment method before turning R2 on, even on its free tier.",
          },
    turnOn(dashboardLinks(input.view.accountId).r2),
    (probe) => unknownSentence(probe, "r2"),
  );
}

function zoneRow(input: CapabilityRowsInput): CapabilityRow {
  return probeRow(
    input,
    {
      id: "zone",
      name: "A domain",
      why: "Lets apps answer on your own web addresses and receive email.",
      usedBy: usedBy(input.needs, (n) => n.zone),
      needed: inUse(input, (n) => n.zone),
    },
    input.view.zone,
    (probe) =>
      probe.state === "available"
        ? { ready: true, found: "An active domain" }
        : {
            ready: false,
            found: "No active domain",
            note: "If the account has one, Appflare's token may lack the optional Zone: Read permission.",
          },
    addDomain(dashboardLinks(input.view.accountId).domains),
    (probe) => unknownSentence(probe, "zone"),
  );
}

function emailRoutingRow(input: CapabilityRowsInput): CapabilityRow {
  const { view } = input;
  const links = dashboardLinks(view.accountId);
  const noDomain = view.emailRouting?.state === "no-zone";
  return probeRow(
    input,
    {
      id: "email-routing",
      name: "Email Routing",
      why: "Delivers a domain's email to an app. Installing such an app turns it on.",
      usedBy: usedBy(input.needs, (n) => n.emailRouting),
      needed: inUse(input, (n) => n.emailRouting),
    },
    view.emailRouting,
    (probe) =>
      probe.state === "available"
        ? { ready: true, found: "Available on a domain of the account" }
        : { ready: false, found: "Needs a domain first" },
    // With no domain yet, adding one comes first.
    noDomain ? addDomain(links.domains) : turnOn(links.emailRouting),
    (probe) =>
      view.zone?.state === "unknown"
        ? "Appflare checks Email Routing on a domain of the account, and could not list the domains."
        : unknownSentence(probe, "email-routing"),
  );
}

function analyticsEngineRow(input: CapabilityRowsInput): CapabilityRow {
  return probeRow(
    input,
    {
      id: "analytics-engine",
      name: "Analytics Engine",
      why: "Stores what apps count and chart, such as page views. Turning it on is free.",
      usedBy: usedBy(input.needs, (n) => n.analyticsEngine),
      needed: inUse(input, (n) => n.analyticsEngine),
    },
    input.view.analyticsEngine,
    (probe) =>
      probe.state === "enabled"
        ? { ready: true, found: "Turned on" }
        : {
            ready: false,
            found: "Not turned on",
            problem:
              "It stays off until its page in the Cloudflare dashboard is opened once. Apps that write to it cannot be installed until then.",
          },
    turnOn(dashboardLinks(input.view.accountId).analyticsEngine),
    (probe) => unknownSentence(probe, "analytics-engine"),
  );
}

function zeroTrustRow(input: CapabilityRowsInput): CapabilityRow {
  return probeRow(
    input,
    {
      id: "zero-trust",
      name: "Zero Trust",
      why: "Lets you put a Cloudflare sign-in page in front of Appflare or an app.",
      usedBy: usedBy(input.needs, (n) => n.access),
      needed: inUse(input, (n) => n.access),
    },
    input.view.zeroTrust,
    (probe) =>
      probe.state === "exists"
        ? { ready: true, found: `Set up, team domain ${probe.teamDomain}` }
        : { ready: false, found: "Not set up" },
    turnOn(dashboardLinks(input.view.accountId).zeroTrust),
    (probe) => unknownSentence(probe, "zero-trust"),
  );
}

/**
 * Sandbox builds, from `sandboxReadinessOf`, the same reading the app page
 * and the install start use. Ready when they are on, being turned on, or
 * turn on by themselves the first time an app needs them; paid plan only
 * while the account is not on Workers Paid; when something else is
 * missing, needs action if an app in the account is built this way and is
 * not set up otherwise; needs action after a failed try to turn them on.
 * "Set up" opens Building apps, where they are turned on by hand; while
 * they are being turned on, the job's progress is the only link.
 */
function sandboxRow(input: CapabilityRowsInput): CapabilityRow {
  const { view, sandbox, needs, sandboxJobs } = input;
  const missing = inUse(input, (n) => n.sandbox) ? "needs-action" : "not-set-up";
  const base = {
    id: "sandbox" as const,
    name: "Sandbox builds",
    why: "Builds apps that have no ready-made release inside your account.",
  };
  const used = usedBy(needs, (n) => n.sandbox);
  const readiness = withSandboxJobs(
    sandboxReadinessOf(view, sandbox === "enabled"),
    sandboxJobs ?? NO_SANDBOX_JOBS,
  );
  const row = (
    state: CapabilityState,
    over: Partial<CapabilityDetails>,
    action: CapabilityAction | null = SET_UP_SANDBOX,
  ): CapabilityRow => ({
    ...base,
    state,
    action,
    details: details(view, { usedBy: used, ...over }),
  });
  switch (readiness.state) {
    case "on":
      return row("ready", { found: "On" }, null);
    case "enabling":
      return row(
        "ready",
        {
          found: "Being turned on, which takes about two minutes",
          job: { href: `/jobs/${readiness.jobId}`, label: "View progress" },
        },
        null,
      );
    case "ready-auto": {
      const failure = readiness.failure;
      if (failure !== undefined) {
        return row("needs-action", {
          found: "The last try to turn them on failed",
          problem: `${failure.message} The next app that needs them tries again.`,
          job: { href: `/jobs/${failure.id}`, label: "View log" },
        });
      }
      return row("ready", {
        found: "Turn on by themselves the first time an app needs them",
        // Not confirmed: a probe has not run or could not tell; the start asks again.
        note: readiness.confirmed
          ? null
          : "Appflare has not confirmed Containers and R2 yet; it checks again before turning them on.",
      });
    }
    case "needs-plan":
      return row("paid-only", {
        found: "Needs Workers Paid",
        problem: "Builds run in Cloudflare Containers, which only Workers Paid includes.",
        // Why the plan could not be told, when the token lacks Containers: Edit.
        note:
          view.containers?.state === "unknown" && view.containers.reason === "no-permission"
            ? "If the account is on Workers Paid, add Containers: Edit to Appflare's token so Appflare can tell."
            : null,
      });
    case "needs-r2":
      return row(missing, {
        found: "Needs R2 storage turned on",
        problem:
          "The sandbox keeps build outputs in R2. Open R2 in the Cloudflare dashboard once to turn it on.",
      });
    case "needs-permission":
      return row(missing, {
        found: "Needs a token permission",
        problem: readiness.missing,
      });
  }
}

/**
 * The token permissions Appflare cannot work without, by the probe that
 * shows them missing, and the optional ones, each named with what it is for.
 */
const REQUIRED_PERMISSIONS = [
  { probe: "workersDev", name: "Workers Scripts" },
  { probe: "r2", name: "Workers R2 Storage" },
] as const satisfies ReadonlyArray<{ probe: keyof CapabilitiesView; name: string }>;

const OPTIONAL_PERMISSIONS = [
  { probe: "workersPlan", name: "Billing (to detect the Workers plan)" },
  { probe: "zone", name: "Zone (for domains)" },
  { probe: "emailRouting", name: "Zone Settings (for Email Routing)" },
  { probe: "zeroTrust", name: "Access: Organizations (for Zero Trust)" },
  { probe: "containers", name: "Containers (for sandbox builds)" },
] as const satisfies ReadonlyArray<{ probe: keyof CapabilitiesView; name: string }>;

function refused(view: CapabilitiesView, probe: keyof CapabilitiesView): boolean {
  const value = view[probe] as Probe;
  return isUnknown(value) && value.reason === "no-permission";
}

/** "A", "A and B", "A, B and C". */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Whether a probe got an answer: it ran, and was neither refused nor failed. */
function answered(view: CapabilitiesView, probe: keyof CapabilitiesView): boolean {
  const value = view[probe] as Probe;
  return value !== null && !isUnknown(value);
}

/**
 * The token's permissions, as the probes found them: needs action when
 * Cloudflare refused a read Appflare cannot work without; could not check
 * when none of those reads got an answer (they failed or never ran);
 * ready otherwise, with the optional permissions it lacks named in the
 * details.
 */
function tokenPermissionsRow({ view }: CapabilityRowsInput): CapabilityRow {
  const base = {
    id: "token-permissions" as const,
    name: "Token permissions",
    why: "Appflare can only set up what its Cloudflare token allows.",
  };
  const fix: CapabilityAction = {
    kind: "edit-token",
    label: "Edit token in Cloudflare",
    href: dashboardLinks(view.accountId).accountApiTokens,
  };
  if (view.checkedAt === null) {
    return {
      ...base,
      state: "could-not-check",
      action: null,
      details: details(view, { problem: NOT_CHECKED }),
    };
  }
  const missing = REQUIRED_PERMISSIONS.filter((p) => refused(view, p.probe)).map((p) => p.name);
  if (missing.length === 0 && !REQUIRED_PERMISSIONS.some((p) => answered(view, p.probe))) {
    return {
      ...base,
      state: "could-not-check",
      action: null,
      details: details(view, {
        problem:
          "The checks that show the token's permissions (the workers.dev address and R2) got no answer.",
      }),
    };
  }
  const optional = OPTIONAL_PERMISSIONS.filter((p) => refused(view, p.probe)).map((p) => p.name);
  const note =
    optional.length === 0
      ? null
      : `Optional permissions the token does not have: ${listOf(optional)}.`;
  if (missing.length > 0) {
    return {
      ...base,
      state: "needs-action",
      action: fix,
      details: details(view, {
        found: "Missing permissions Appflare needs",
        source: "detected",
        problem: `Cloudflare refused the token's reads that need ${listOf(missing)}. Edit the token in the Cloudflare dashboard (editing keeps its value) and add ${missing.length === 1 ? "it" : "them"}.`,
        note,
      }),
    };
  }
  return {
    ...base,
    state: "ready",
    action: null,
    details: details(view, { found: "Has what Appflare needs", source: "detected", note }),
  };
}

/** The rows, in the order they are shown. */
export function capabilityRows(input: CapabilityRowsInput): CapabilityRow[] {
  return [
    planRow(input),
    workersDevRow(input),
    r2Row(input),
    zoneRow(input),
    emailRoutingRow(input),
    analyticsEngineRow(input),
    zeroTrustRow(input),
    sandboxRow(input),
    tokenPermissionsRow(input),
  ];
}

/**
 * The meter's numbers: rows that are ready out of the rows that can be on
 * this plan. A row only the paid plan offers counts in neither.
 */
export function capabilityProgress(rows: readonly CapabilityRow[]): {
  ready: number;
  total: number;
} {
  const possible = rows.filter((r) => r.state !== "paid-only");
  return { ready: possible.filter((r) => r.state === "ready").length, total: possible.length };
}

/**
 * The rows that need the admin: an app in the account needs what they
 * lack. Home lists these, and only these, among what needs attention.
 */
export function rowsNeedingAction(rows: readonly CapabilityRow[]): CapabilityRow[] {
  return rows.filter((r) => r.state === "needs-action");
}

/** "5 of 7 ready". */
export function progressLabel({ ready, total }: { ready: number; total: number }): string {
  return `${ready} of ${total} ready`;
}

/** The element id of a row, so other pages can link to it (`capability-sandbox`). */
export function capabilityAnchor(id: CapabilityId): `capability-${CapabilityId}` {
  return `capability-${id}`;
}

/** The Analytics Engine row, where a refused install points. */
export const ANALYTICS_ENGINE_CAPABILITY_LINK = {
  href: settingsLink("account", capabilityAnchor("analytics-engine")),
  label: "Analytics Engine in Your account",
} as const;
