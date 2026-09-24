import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { installs } from "../db/schema";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { isDevBuild } from "../telemetry/state.server";
import {
  type AutoUpdateSettings,
  type SetAutoUpdateDefaultsInput,
  type SetInstallAutoUpdateInput,
  settingOn,
} from "./auto-update";

/** The two account settings of automatic updates, as stored (absent means off). */
export async function readAutoUpdateDefaults(
  db: Database,
): Promise<{ apps: boolean; manager: boolean }> {
  const stored = await readSettings(db, [SETTING.autoUpdateApps, SETTING.autoUpdateManager]);
  return {
    apps: settingOn(stored.auto_update_apps),
    manager: settingOn(stored.auto_update_manager),
  };
}

export async function readAutoUpdateSettings(
  db: Database,
  managerVersion: string,
): Promise<AutoUpdateSettings> {
  return { ...(await readAutoUpdateDefaults(db)), devBuild: isDevBuild(managerVersion) };
}

/** Writes the settings that are given; the others stay as they are. */
export async function writeAutoUpdateDefaults(
  db: Database,
  input: SetAutoUpdateDefaultsInput,
  now: Date = new Date(),
): Promise<void> {
  const on = (value: boolean | undefined) =>
    value === undefined ? undefined : value ? "on" : "off";
  await writeSettings(
    db,
    { [SETTING.autoUpdateApps]: on(input.apps), [SETTING.autoUpdateManager]: on(input.manager) },
    now,
  );
}

export class AutoUpdateError extends Error {
  override name = "AutoUpdateError";
}

/**
 * An install's own choice. Allowed whatever the install's state, except
 * once it is uninstalled; a running job is not affected (the cron reads the
 * choice before it starts one).
 */
export async function writeInstallAutoUpdate(
  db: Database,
  input: SetInstallAutoUpdateInput,
): Promise<void> {
  const [row] = await db
    .select({ status: installs.status })
    .from(installs)
    .where(eq(installs.id, input.installId))
    .limit(1);
  if (row === undefined) throw new AutoUpdateError("There is no such install.");
  if (row.status === "uninstalled") throw new AutoUpdateError("This install is uninstalled.");
  await db
    .update(installs)
    .set({ auto_update: input.choice })
    .where(eq(installs.id, input.installId));
}
