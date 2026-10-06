import { NEEDS_ADMIN_COPY } from "../auto-update/auto-update";
import type { CapabilityId } from "../capabilities/capability-rows";
import type { HealthStatus } from "../db/schema";
import type { DeployCopyCleanup } from "../deploy-button/deploy-copy";
import { installAgainLink } from "../installs/install-again";

/**
 * What needs someone's attention, in one list: Home's "Needs attention"
 * section shows it, the sidebar's Home item counts it, and the sidebar's
 * app rows take their status dot from it. Rows are ordered by severity:
 *
 * 1. a job of an app that failed, with no job of that app finishing after it;
 * 2. an app that did not answer its last health check (not when Cloudflare
 *    Access answered in its place: that says nothing about the app);
 * 2b. an app whose catalog entry now requires Cloudflare Access protection
 *    while Appflare does not protect it (a catalog revision said so; Appflare
 *    never protects an app on its own, and holds its updates meanwhile);
 * 3. an app with an update (one that needs the admin's input says why, and
 *    one whose catalog entry changed how it is installed says it takes a
 *    reinstall);
 * 4. something in the account that apps need and that is not ready yet
 *    (admins only; each can be put away with "Not needed", in this browser);
 * 5. the deploy-copy cleanup, and the notice that an older Appflare serves a
 *    newer database.
 *
 * Appflare's own update is not a row: the sidebar's Appflare card offers it.
 * Pure and client-safe.
 */

export type AttentionKind =
  | "failed-job"
  | "not-responding"
  | "access-required"
  | "update"
  | "account"
  | "deploy-copy"
  | "downgrade";

/** The order rows appear in, most severe first. */
export const SEVERITY_ORDER: readonly AttentionKind[] = [
  "failed-job",
  "not-responding",
  "access-required",
  "update",
  "account",
  "deploy-copy",
  "downgrade",
];

/** What the model reads of an install. */
export interface AttentionApp {
  id: string;
  /** What Home calls the install (`installLabel`: never its Worker name). */
  label: string;
  status: string;
  version: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  /**
   * The catalog's newer version takes a reinstall: its entry changed how the
   * app is installed (installs/tier-change.ts). Never with `updateAvailable`.
   */
  reinstallNeeded?: boolean;
  /**
   * Why the update waits for an admin's input (a sentence), when the
   * install's own page has to start it; null when Update can start it.
   */
  updateNeeds: string | null;
  healthStatus: HealthStatus | null;
  /**
   * Cloudflare Access answered the last check in the app's place: it says
   * nothing about the app, so the app is not listed as not responding.
   */
  healthAccess: boolean;
  /** ISO 8601 */
  healthCheckedAt: string | null;
  /**
   * Its catalog entry requires Cloudflare Access protection and Appflare does
   * not protect it; absent when not known.
   */
  accessRequired?: boolean;
  /** The app key of its catalog page; with `origin`, for "Install again". Absent when not known. */
  slug?: string;
  /** Where its code comes from (`INSTALL_ORIGINS`); absent when not known. */
  origin?: string;
}

/** An app's latest finished job, when it failed. */
export interface FailedJob {
  id: string;
  installId: string;
  kind: string;
  /** A database restore (recorded as a `rollback` job). */
  restore: boolean;
  /** A deletion of the data an uninstall kept (recorded as an `uninstall` job). */
  deleteRetained: boolean;
  /** A settings change that turns Cloudflare Access protection on or off. */
  accessChange?: boolean;
  /** The version an update or install was moving to, when the job recorded one. */
  version: string | null;
  /** The build an install or update from a repository used, when the job recorded one. */
  buildId?: string | null;
  /** ISO 8601 */
  finishedAt: string | null;
}

/** Something in the account that apps need and that is not ready (see `account-attention.ts`). */
export interface AccountAttentionRow {
  id: CapabilityId;
  name: string;
  /** What the check found, in a few words ("Not turned on"); null when it found nothing. */
  found: string | null;
  /** Why apps need it. */
  why: string;
  /** Whether "Not needed" may hide it; never for what every app needs, such as the token's permissions. */
  dismissible: boolean;
  /** The installs that need it, by id, sorted. */
  neededBy: string[];
}

/**
 * What "Not needed" remembers of an account row: the row and the installs
 * that needed it then, so an app installed later that needs it too brings
 * the row back.
 */
export function accountRowKey(row: Pick<AccountAttentionRow, "id" | "neededBy">): string {
  // FNV-1a over the install ids: short, and the same for the same set.
  let hash = 0x811c9dc5;
  for (const char of row.neededBy.join(",")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${row.id}:${hash.toString(16).padStart(8, "0")}`;
}

/** An older Appflare serves a database a newer one migrated. */
export interface Downgrade {
  /** The running version. */
  version: string;
  /** Whether the Deploy to Cloudflare button deployed this manager. */
  deployButton: boolean;
}

export interface AttentionInput {
  isAdmin: boolean;
  apps: readonly AttentionApp[];
  failedJobs: readonly FailedJob[];
  /** Read for admins only; members get none. */
  accountRows: readonly AccountAttentionRow[];
  /** Account rows put away with "Not needed" in this browser. */
  dismissedAccountRows: ReadonlySet<string>;
  deployCopy: DeployCopyCleanup | null;
  downgrade: Downgrade | null;
  /**
   * Updates the last "Update all" could not start because they need the
   * admin's input, by install id, with why. They show "Review" until the
   * page reloads the installs.
   */
  leftForAdmin?: ReadonlyMap<string, string>;
}

interface AppItem {
  installId: string;
  label: string;
}

export type AttentionItem =
  | ({
      kind: "failed-job";
      key: string;
      job: FailedJob;
      /** "Install again" for an install that did not finish (admins); null otherwise. */
      againHref: string | null;
    } & AppItem)
  | ({
      kind: "not-responding";
      key: string;
      health: Exclude<HealthStatus, "verified">;
      checkedAt: string | null;
    } & AppItem)
  | ({ kind: "access-required"; key: string } & AppItem)
  | ({
      kind: "update";
      key: string;
      version: string;
      latestVersion: string;
      /** Why it waits for the admin's input ("Review"); null when Update starts it. */
      needs: string | null;
      /** No update can start: the new version takes a reinstall (`needs` says so). */
      reinstall: boolean;
    } & AppItem)
  | { kind: "account"; key: string; row: AccountAttentionRow }
  | { kind: "deploy-copy"; key: string; cleanup: DeployCopyCleanup }
  | { kind: "downgrade"; key: string; downgrade: Downgrade };

/** An install with a job running: its last failure is being dealt with. */
function busy(status: string): boolean {
  return status === "installing" || status === "updating";
}

function byLabel(a: { label: string }, b: { label: string }): number {
  return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
}

export function attentionItems(input: AttentionInput): AttentionItem[] {
  const apps = new Map(input.apps.map((a) => [a.id, a]));
  const failed: AttentionItem[] = input.failedJobs
    .flatMap((job) => {
      const app = apps.get(job.installId);
      if (app === undefined || busy(app.status)) return [];
      return [
        {
          kind: "failed-job" as const,
          key: `job:${job.id}`,
          installId: app.id,
          label: app.label,
          job,
          againHref:
            input.isAdmin &&
            job.kind === "install" &&
            app.slug !== undefined &&
            app.origin !== undefined
              ? installAgainLink({
                  id: app.id,
                  status: app.status,
                  origin: app.origin,
                  appKey: app.slug,
                  buildId: job.buildId ?? null,
                })
              : null,
        },
      ];
    })
    .sort(byLabel);

  const notResponding: AttentionItem[] = input.apps
    .flatMap((app) => {
      const health = app.healthStatus;
      if (app.status !== "installed" || health === null || health === "verified") return [];
      if (app.healthAccess) return [];
      return [
        {
          kind: "not-responding" as const,
          key: `health:${app.id}`,
          installId: app.id,
          label: app.label,
          health,
          checkedAt: app.healthCheckedAt,
        },
      ];
    })
    .sort(byLabel);

  const accessRequired: AttentionItem[] = input.apps
    .flatMap((app) =>
      app.status === "installed" && app.accessRequired === true
        ? [
            {
              kind: "access-required" as const,
              key: `access:${app.id}`,
              installId: app.id,
              label: app.label,
            },
          ]
        : [],
    )
    .sort(byLabel);

  const updates: AttentionItem[] = input.apps
    .flatMap((app) => {
      const latest = app.latestVersion;
      const reinstall = app.reinstallNeeded === true;
      if (app.status !== "installed" || !(app.updateAvailable || reinstall) || latest === null) {
        return [];
      }
      return [
        {
          kind: "update" as const,
          key: `update:${app.id}`,
          installId: app.id,
          label: app.label,
          version: app.version,
          latestVersion: latest,
          // Never null for a reinstall, so no Update button offers it.
          needs: reinstall
            ? NEEDS_ADMIN_COPY["reinstall-needed"]
            : (app.updateNeeds ?? input.leftForAdmin?.get(app.id) ?? null),
          reinstall,
        },
      ];
    })
    .sort(byLabel);

  const account: AttentionItem[] = input.isAdmin
    ? input.accountRows
        .filter((row) => !row.dismissible || !input.dismissedAccountRows.has(accountRowKey(row)))
        .map((row) => ({ kind: "account" as const, key: `account:${row.id}`, row }))
    : [];

  const notices: AttentionItem[] = [];
  if (input.deployCopy !== null) {
    notices.push({ kind: "deploy-copy", key: "deploy-copy", cleanup: input.deployCopy });
  }
  if (input.downgrade !== null) {
    notices.push({ kind: "downgrade", key: "downgrade", downgrade: input.downgrade });
  }

  return [...failed, ...notResponding, ...accessRequired, ...updates, ...account, ...notices];
}

/** What an app's row in the sidebar shows beside its name, most severe first. */
export type AppSignal = "failed" | "not-responding" | "update" | "reinstall";

/** Each app's most severe row, as the dot on its sidebar row; apps without one are left out. */
export function appSignals(items: readonly AttentionItem[]): Map<string, AppSignal> {
  const signals = new Map<string, AppSignal>();
  for (const item of items) {
    const signal =
      item.kind === "failed-job"
        ? "failed"
        : item.kind === "not-responding"
          ? "not-responding"
          : item.kind === "update"
            ? item.reinstall
              ? "reinstall"
              : "update"
            : null;
    // Items come most severe first: the first one of an app wins.
    if (signal !== null && "installId" in item && !signals.has(item.installId)) {
      signals.set(item.installId, signal);
    }
  }
  return signals;
}

/** The dot's meaning, for its tooltip and screen readers. */
export const APP_SIGNAL_LABELS: Record<AppSignal, string> = {
  failed: "Something did not finish",
  "not-responding": "Not responding",
  update: "Update available",
  reinstall: "New version takes a reinstall",
};

/** The count on the sidebar's Home item and what it stands for. */
export function attentionBadge(items: readonly AttentionItem[]): { count: number; label: string } {
  const count = items.length;
  return {
    count,
    label: count === 1 ? "1 thing needs your attention" : `${count} things need your attention`,
  };
}

/** The updates "Update all" starts: every update row that needs nothing from the admin. */
export function updateAllTargets(
  items: readonly AttentionItem[],
): Extract<AttentionItem, { kind: "update" }>[] {
  return items.filter(
    (item): item is Extract<AttentionItem, { kind: "update" }> =>
      item.kind === "update" && item.needs === null,
  );
}

/** "Update all" is offered to admins when at least this many updates can start at once. */
export const UPDATE_ALL_MIN = 2;
