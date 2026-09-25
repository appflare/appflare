import {
  commonTelemetryProperties,
  type TelemetryEvent,
  type TelemetryValue,
} from "@appflare/schema";
import { isUpdateAvailable } from "../catalog/versions";
import type { ChannelKind } from "../notifications/schema";
import { classifyJobError } from "./classify";

/**
 * Builds the manager's usage-data events from rows already read. Pure: the
 * cron (report.server.ts) does the reading and sending. Everything here
 * turns records into enums, counts, booleans, versions and durations; names,
 * ids, hostnames and messages never make it into a property.
 */

export const EVENT = {
  heartbeat: "manager heartbeat",
  jobStarted: "job started",
  jobFinished: "job finished",
  setupCompleted: "manager setup completed",
  opened: "manager opened",
} as const;

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a time, in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Namespace of every event uuid (a fixed random UUID). */
const UUID_NAMESPACE = "8b3f6a52-1d6e-4c1b-9a57-0f3c2e7d4b19";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replaceAll("-", "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A name-based (v5) UUID: the same name always gives the same uuid, so an
 * event resent after a lost response is dropped by PostHog as a duplicate.
 */
export async function uuidV5(name: string, namespace: string = UUID_NAMESPACE): Promise<string> {
  const ns = hexToBytes(namespace);
  const bytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + bytes.length);
  input.set(ns);
  input.set(bytes, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Everything the heartbeat is built from, read by the cron in one batch. */
export interface HeartbeatInput {
  now: number;
  managerVersion: string;
  schemaVersion: number;
  accountPlan: string | undefined;
  /** The catalog index URL is Appflare's own. */
  officialCatalog: boolean;
  /**
   * When setup happened (ms): the first user's creation, or an earlier
   * stored setup time. Null when neither is known.
   */
  setupAt: number | null;
  users: number;
  admins: number;
  passkeys: number;
  passkeyUsers: number;
  accessEnabled: boolean;
  sandboxConnected: boolean;
  managerBehindLatest: boolean;
  /** "Automatically update Appflare" is on. */
  managerSelfUpdateAuto: boolean;
  /** "Automatically update apps" (the default of installs that follow it) is on. */
  autoUpdateDefault: boolean;
  /** Installs that are not uninstalled. */
  installs: readonly {
    slug: string;
    status: string;
    buildKind: string;
    version: string;
    /** When the running version was deployed (ms). */
    updatedAt: number;
    /** The install's automatic-update choice (`inherit`, `on`, `off`). */
    autoUpdate: string;
  }[];
  /** Latest version of each app in the cached catalog index; null when nothing is cached. */
  catalogVersions: ReadonlyMap<string, string> | null;
  installsWithDomain: number;
  installsWithEmailRouting: number;
  installsWithCrons: number;
  removedWithRetained: number;
  /** Notification channels by kind (counts only). */
  notificationChannels: Record<ChannelKind, number>;
}

function counts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

/** The tier as usage data names it (`self-deploying` becomes `self_deploying`). */
export function tierName(buildKind: string | null | undefined): string | null {
  if (buildKind === null || buildKind === undefined) return null;
  return buildKind.replaceAll("-", "_");
}

/**
 * Whether a slug may be sent: only an official catalog's slugs are, and when
 * the cached index is known, only slugs it lists. Never an install's from a
 * repository (`repository:<name>`): its name comes from the repository, and
 * nothing about a repository is ever sent.
 */
export function officialSlug(
  slug: string,
  officialCatalog: boolean,
  catalogVersions: ReadonlyMap<string, string> | null,
): string | null {
  if (!officialCatalog) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null;
  if (catalogVersions !== null && !catalogVersions.has(slug)) return null;
  return slug;
}

/** The daily heartbeat's properties (without the common ones). */
export function heartbeatProperties(input: HeartbeatInput): Record<string, TelemetryValue> {
  const byStatus = counts(["installed", "failed", "installing", "updating", "uninstalling"]);
  const byTier = counts(["artifact", "sandbox", "self_deploying"]);
  const byAge = counts([
    "current",
    "behind_lt_7d",
    "behind_7_30d",
    "behind_30_90d",
    "behind_gt_90d",
  ]);
  const byAutoUpdate = counts(["on", "off", "inherit"]);
  const apps = new Set<string>();
  for (const install of input.installs) {
    if (install.autoUpdate in byAutoUpdate) {
      byAutoUpdate[install.autoUpdate as keyof typeof byAutoUpdate]++;
    }
    if (install.status in byStatus) byStatus[install.status as keyof typeof byStatus]++;
    const tier = tierName(install.buildKind);
    if (tier !== null && tier in byTier) byTier[tier as keyof typeof byTier]++;
    const latest = input.catalogVersions?.get(install.slug);
    if (latest === undefined || !isUpdateAvailable(install.version, latest)) {
      byAge.current++;
    } else {
      const days = (input.now - install.updatedAt) / DAY_MS;
      if (days < 7) byAge.behind_lt_7d++;
      else if (days < 30) byAge.behind_7_30d++;
      else if (days < 90) byAge.behind_30_90d++;
      else byAge.behind_gt_90d++;
    }
    if (install.status === "installed" || install.status === "updating") {
      const slug = officialSlug(install.slug, input.officialCatalog, input.catalogVersions);
      if (slug !== null) apps.add(slug);
    }
  }
  return {
    schema_version: input.schemaVersion,
    account_plan:
      input.accountPlan === "free" || input.accountPlan === "paid" ? input.accountPlan : "unset",
    catalog: input.officialCatalog ? "official" : "custom",
    days_since_setup:
      input.setupAt === null ? null : Math.max(0, Math.floor((input.now - input.setupAt) / DAY_MS)),
    users: input.users,
    admins: input.admins,
    passkeys_enabled: input.passkeys > 0,
    passkey_users: input.passkeyUsers,
    access_enabled: input.accessEnabled,
    sandbox_connected: input.sandboxConnected,
    manager_behind_latest: input.managerBehindLatest,
    manager_self_update_auto: input.managerSelfUpdateAuto,
    auto_update_default: input.autoUpdateDefault ? "on" : "off",
    installs_auto_update: byAutoUpdate,
    notification_channels: { ...input.notificationChannels },
    installs_total: input.installs.length,
    installs_by_status: byStatus,
    installs_by_tier: byTier,
    installs_by_version_age: byAge,
    installs_with_domain: input.installsWithDomain,
    installs_with_email_routing: input.installsWithEmailRouting,
    installs_with_crons: input.installsWithCrons,
    removed_with_retained: input.removedWithRetained,
    apps: [...apps].sort(),
  };
}

/** A job row joined with its install (and, for a rollback, its snapshot). */
export interface JobRow {
  id: string;
  kind: string;
  status: string;
  inputJson: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** The install's app; null for a self-update. */
  appSlug: string | null;
  installVersion: string | null;
  buildKind: string | null;
  /** A rollback's snapshot: the version the update it undoes moved to. */
  snapshotTargetVersion: string | null;
  /** Who started the job (`admin` or `schedule`). */
  startedBy: string;
}

function parseInput(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A job's kind as usage data names it. A database restore and deleting a
 * removed app's retained data are recorded as a rollback and an uninstall;
 * they are told apart here because their outcomes mean different things.
 */
export function jobKind(row: Pick<JobRow, "kind" | "inputJson">): string {
  const input = parseInput(row.inputJson);
  if (row.kind === "rollback" && input.restore === true) return "restore";
  if (row.kind === "uninstall" && input.deleteRetained === true) return "delete_retained";
  return row.kind;
}

/** Jobs about the sandbox Worker itself (enable, update, disable), not an app. */
const SANDBOX_WORKER_JOB_KINDS: ReadonlySet<string> = new Set([
  "sandbox_enable",
  "sandbox_update",
  "sandbox_disable",
]);

function jobTier(row: JobRow, input: Record<string, unknown>): string | null {
  if (row.kind === "self_update" || row.kind === "self_rollback") return null;
  if (SANDBOX_WORKER_JOB_KINDS.has(row.kind)) return null;
  if (input.selfDeploying === true) return "self_deploying";
  if (input.sandboxBuild === true || input.runKind === "build") return "sandbox";
  return tierName(row.buildKind);
}

/** The properties both job events share. */
export function jobProperties(
  row: JobRow,
  officialCatalog: boolean,
  catalogVersions: ReadonlyMap<string, string> | null,
): Record<string, TelemetryValue> {
  const input = parseInput(row.inputJson);
  const kind = jobKind(row);
  let slug: string;
  if (row.kind === "self_update" || row.kind === "self_rollback") slug = "appflare";
  else if (SANDBOX_WORKER_JOB_KINDS.has(row.kind)) slug = "appflare-sandbox";
  else slug = officialSlug(row.appSlug ?? "", officialCatalog, catalogVersions) ?? "custom";
  let version: string | null;
  let from: string | null = null;
  switch (row.kind) {
    case "install":
    case "sandbox_enable":
    case "sandbox_disable":
      version = str(input.version);
      break;
    case "update":
    case "self_update":
    case "sandbox_update":
      version = str(input.version);
      from = str(input.fromVersion);
      break;
    case "self_rollback":
      // Only the kind: which versions an admin moved Appflare between stays in the manager.
      version = null;
      break;
    case "rollback":
      version =
        kind === "restore" ? row.installVersion : (str(input.toVersion) ?? row.installVersion);
      from = kind === "restore" ? null : row.snapshotTargetVersion;
      break;
    default:
      version = row.installVersion;
  }
  // Where the code comes from: the catalog, a repository, or a catalog app
  // built from source. Only that kind is sent, never the repository.
  const origin =
    input.origin === "repository" || input.origin === "source" ? input.origin : "catalog";
  // Nothing from a custom catalog or from source: those versions stay in the manager too.
  const custom = slug === "custom" || origin !== "catalog";
  return {
    kind,
    slug: origin === "repository" ? "custom" : slug,
    catalog_version: custom ? null : version,
    from_version: custom ? null : from,
    tier: jobTier(row, input),
    origin,
    // `auto`: the cron started it (automatic updates), or it turned sandbox
    // builds on for an install or build that needed them; `manual`: an admin did.
    trigger:
      row.startedBy === "schedule" ||
      (row.kind === "sandbox_enable" &&
        typeof input.neededBy === "object" &&
        input.neededBy !== null)
        ? "auto"
        : "manual",
  };
}

/**
 * The job events whose moment falls in `(from, to]`: `job started` at the
 * job's start and `job finished` at its end, each at the job's own time.
 */
export async function jobEvents(
  rows: readonly JobRow[],
  window: { from: number; to: number },
  base: Record<string, TelemetryValue>,
  installId: string,
  officialCatalog: boolean,
  catalogVersions: ReadonlyMap<string, string> | null,
): Promise<TelemetryEvent[]> {
  const inWindow = (t: number | null): t is number =>
    t !== null && t > window.from && t <= window.to;
  const events: TelemetryEvent[] = [];
  for (const row of rows) {
    const props = { ...base, ...jobProperties(row, officialCatalog, catalogVersions) };
    if (inWindow(row.startedAt)) {
      events.push({
        event: EVENT.jobStarted,
        timestamp: new Date(row.startedAt).toISOString(),
        uuid: await uuidV5(`${installId}:${EVENT.jobStarted}:${row.id}`),
        properties: props,
      });
    }
    const ended = row.status === "succeeded" || row.status === "failed";
    if (ended && inWindow(row.finishedAt)) {
      const failed = row.status === "failed";
      const failure = failed ? classifyJobError(row.error) : null;
      events.push({
        event: EVENT.jobFinished,
        timestamp: new Date(row.finishedAt).toISOString(),
        uuid: await uuidV5(`${installId}:${EVENT.jobFinished}:${row.id}`),
        properties: {
          ...props,
          outcome: failed ? "failed" : "succeeded",
          duration_s:
            row.startedAt === null
              ? null
              : Math.max(0, Math.round((row.finishedAt - row.startedAt) / 1000)),
          error_category: failure?.errorCategory ?? null,
          failed_phase: failure?.failedPhase ?? null,
          cf_status: failure?.cfStatus ?? null,
          cf_code: failure?.cfCode ?? null,
        },
      });
    }
  }
  return events;
}

/** The properties every manager event carries. */
export function managerBase(managerVersion: string): Record<string, TelemetryValue> {
  return commonTelemetryProperties("manager", managerVersion);
}
