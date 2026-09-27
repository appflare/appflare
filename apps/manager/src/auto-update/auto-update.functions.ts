import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { createDb } from "../db/client";
import { requireRole, requireSession } from "../server/auth.server";
import {
  type AutoUpdateSettings,
  setAutoUpdateDefaultsInput,
  setInstallAutoUpdateInput,
} from "./auto-update";
import {
  AutoUpdateError,
  readAutoUpdateSettings,
  writeAutoUpdateDefaults,
  writeInstallAutoUpdate,
} from "./auto-update.server";

/** Settings, Updates, "Automatic app updates", and an install's own choice on its page. */

/** Any signed-in user: the account settings (members see them read-only). */
export const getAutoUpdateSettings = createServerFn({ method: "GET" }).handler(
  async (): Promise<AutoUpdateSettings> => {
    await requireSession();
    return readAutoUpdateSettings(createDb(env.DB), env.APPFLARE_VERSION);
  },
);

/** Admin only: turns "Automatically update apps" or "Automatically update Appflare" on or off. */
export const setAutoUpdateDefaults = createServerFn({ method: "POST" })
  .validator(setAutoUpdateDefaultsInput)
  .handler(async ({ data }): Promise<AutoUpdateSettings> => {
    await requireRole("admin");
    const db = createDb(env.DB);
    await writeAutoUpdateDefaults(db, data);
    return readAutoUpdateSettings(db, env.APPFLARE_VERSION);
  });

/** Admin only: an install follows the account default, or is always or never updated automatically. */
export const setInstallAutoUpdate = createServerFn({ method: "POST" })
  .validator(setInstallAutoUpdateInput)
  .handler(async ({ data }): Promise<void> => {
    await requireRole("admin");
    try {
      await writeInstallAutoUpdate(createDb(env.DB), data);
    } catch (error) {
      if (error instanceof AutoUpdateError) throw new Error(error.message);
      throw error;
    }
  });
