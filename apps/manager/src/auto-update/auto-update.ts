import { z } from "zod";
import { isUpdateAvailable } from "../catalog/versions";

/**
 * Automatic updates: which updates the cron may start on its own. Pure and
 * client-safe; the cron (./cron.server.ts) reads the rows and starts the jobs.
 *
 * Two account settings, both off until an admin turns them on: "Automatically
 * update apps" (the default of every install) and "Automatically update
 * Appflare". Each install can follow the default or override it.
 *
 * The cron only ever starts an update that needs nothing from an admin: no
 * value for a secret the new version introduces, no confirmation that it
 * cannot be checked on a preview first, no Workers Paid confirmation for
 * more cron triggers, no build or installer run to approve (sandbox and
 * self-deploying tier apps). Such an update is left to the admin, with the
 * usual banner on the app's page. A version whose update already failed is
 * not tried again automatically.
 */

export const AUTO_UPDATE_CHOICES = ["inherit", "on", "off"] as const;
export type AutoUpdateChoice = (typeof AUTO_UPDATE_CHOICES)[number];

/** Whether the cron may update an install with this choice. */
export function effectiveAutoUpdate(choice: AutoUpdateChoice, appsDefault: boolean): boolean {
  return choice === "inherit" ? appsDefault : choice === "on";
}

/** A stored `on`/`off` setting; anything else (absent included) is off. */
export function settingOn(value: string | undefined): boolean {
  return value === "on";
}

/** At most this many app update jobs start per cron run. */
export const MAX_APP_STARTS_PER_RUN = 3;
/**
 * At most this many app updates are tried per cron run, started or not
 * (each may fetch a signed manifest the first time).
 */
export const MAX_APP_ATTEMPTS_PER_RUN = 10;

/** What the cron knows about one install when it decides. */
export interface AutoUpdateCandidate {
  installId: string;
  status: string;
  buildKind: string;
  choice: AutoUpdateChoice;
  /** The installed catalog version. */
  version: string;
  /** The app's entry in the cached catalog index; null when it is not listed. */
  latest: { version: string; tier: string } | null;
  /**
   * The install was on `latest.version` before: an update to it failed, or a
   * rollback moved the install off it. Null when neither happened.
   */
  triedBefore: "failed" | "rolled-back" | null;
  /** The catalog version an earlier run left for an admin (`installs.auto_update_waiting`). */
  waiting: string | null;
}

export type AppSkipReason =
  | "off"
  | "not-installed"
  | "not-in-catalog"
  | "up-to-date"
  | "needs-approval"
  | "failed-before"
  | "rolled-back"
  | "waiting"
  | "limit";

export type AppDecision =
  | { installId: string; action: "try"; version: string }
  | { installId: string; action: "skip"; reason: AppSkipReason };

/**
 * Which installs the cron tries to update now, in the given order, at most
 * `maxAttempts` of them. A tried update may still need an admin (a new
 * secret, a confirmation), which only its signed manifest tells; the cron
 * then leaves it, remembers the version, and does not try it again (see
 * ./cron.server.ts, which also stops once `MAX_APP_STARTS_PER_RUN` started).
 */
export function planAppUpdates(
  candidates: readonly AutoUpdateCandidate[],
  appsDefault: boolean,
  maxAttempts: number = MAX_APP_ATTEMPTS_PER_RUN,
): AppDecision[] {
  let tried = 0;
  return candidates.map((c): AppDecision => {
    const skip = (reason: AppSkipReason): AppDecision => ({
      installId: c.installId,
      action: "skip",
      reason,
    });
    if (!effectiveAutoUpdate(c.choice, appsDefault)) return skip("off");
    if (c.status !== "installed") return skip("not-installed");
    if (c.latest === null) return skip("not-in-catalog");
    if (!isUpdateAvailable(c.version, c.latest.version)) return skip("up-to-date");
    // Building in the account, or running the app's own installer, costs
    // money on Workers Paid; the admin approves every run.
    if (c.buildKind !== "artifact" || c.latest.tier !== "artifact") return skip("needs-approval");
    if (c.triedBefore === "failed") return skip("failed-before");
    if (c.triedBefore === "rolled-back") return skip("rolled-back");
    if (c.waiting === c.latest.version) return skip("waiting");
    if (tried >= maxAttempts) return skip("limit");
    tried += 1;
    return { installId: c.installId, action: "try", version: c.latest.version };
  });
}

export type SelfUpdateSkipReason =
  | "off"
  | "dev-build"
  | "no-release"
  | "up-to-date"
  | "failed-before";

export type SelfUpdateDecision =
  | { action: "try"; version: string }
  | { action: "skip"; reason: SelfUpdateSkipReason };

/**
 * Whether the cron tries to update Appflare now. A development build never
 * updates itself (every release counts as newer than it). Whether another
 * job runs is checked when the job is claimed.
 */
export function planSelfUpdate(input: {
  enabled: boolean;
  devBuild: boolean;
  /** Whether the newest known release is newer than the running version. */
  updateAvailable: boolean;
  latestVersion: string | null;
  /** A self-update to `latestVersion` already failed. */
  failedBefore: boolean;
}): SelfUpdateDecision {
  if (!input.enabled) return { action: "skip", reason: "off" };
  if (input.devBuild) return { action: "skip", reason: "dev-build" };
  if (input.latestVersion === null) return { action: "skip", reason: "no-release" };
  if (!input.updateAvailable) return { action: "skip", reason: "up-to-date" };
  if (input.failedBefore) return { action: "skip", reason: "failed-before" };
  return { action: "try", version: input.latestVersion };
}

/** Settings, "Automatic updates". */
export interface AutoUpdateSettings {
  apps: boolean;
  manager: boolean;
  /** A development build of Appflare never updates itself. */
  devBuild: boolean;
}

export const setAutoUpdateDefaultsInput = z.object({
  apps: z.boolean().optional(),
  manager: z.boolean().optional(),
});
export type SetAutoUpdateDefaultsInput = z.infer<typeof setAutoUpdateDefaultsInput>;

export const setInstallAutoUpdateInput = z.object({
  installId: z.string().min(1).max(64),
  choice: z.enum(AUTO_UPDATE_CHOICES),
});
export type SetInstallAutoUpdateInput = z.infer<typeof setInstallAutoUpdateInput>;

export const AUTO_UPDATE_COPY = {
  appsLabel: "Automatically update apps",
  appsHelp:
    "Every 30 minutes Appflare checks the catalog. When an app has a new version that needs nothing from you, Appflare updates it the usual way: a snapshot first, a check of the new version before it serves traffic, and the current version kept for a rollback. An update that needs a new secret, a confirmation, or a build waits for you on the app's page. Each app can follow this setting or override it.",
  managerLabel: "Automatically update Appflare",
  managerHelp:
    "Appflare updates itself to a new release when no other job is running, after checking the new version on its preview. If the check fails, the current version keeps serving.",
  devBuild: "This is a development build of Appflare, which never updates itself automatically.",
  membersOnly: "Only admins can change these.",
  installLegend: "Automatic updates",
  choiceLabels: {
    inherit: (appsDefault: boolean) => `Use the account default (${appsDefault ? "on" : "off"})`,
    on: "On",
    off: "Off",
  },
  needsApproval:
    "Updates of this app build it in your account or run its own installer, which you approve each time, so Appflare never starts them on its own.",
  installOn:
    "Appflare starts an update when a new version needs nothing from you; anything else waits here.",
  installOff: "Updates of this app start only when an admin starts them.",
  waiting: (version: string) =>
    `Version ${version} needs something from you (a new secret or a confirmation), so Appflare left it for you. It tries again on its own only when a newer version is out.`,
} as const;

/** How a job's starter reads in job lists. */
export function startedByLabel(startedBy: string): string {
  return startedBy === "schedule" ? "Automatic" : "Admin";
}
