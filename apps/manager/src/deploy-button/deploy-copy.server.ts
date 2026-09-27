import { createDb } from "../db/client";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { type DeployCopyCleanup, deployButtonInstalled, deployCopyCleanup } from "./deploy-copy";

interface DeployCopyEnv {
  DB: D1Database;
  APPFLARE_INSTALL_SOURCE?: string;
}

/** Home's "Clean up the deploy copy" row for this viewer, or null. */
export async function readDeployCopyCleanup(
  env: DeployCopyEnv,
  isAdmin: boolean,
): Promise<DeployCopyCleanup | null> {
  // Nothing to read on managers the button did not deploy, or for members.
  if (!deployButtonInstalled(env) || !isAdmin) return null;
  const row = await readSettings(createDb(env.DB), [
    SETTING.deployCopyDismissedAt,
    SETTING.accountId,
    SETTING.workerName,
  ]);
  return deployCopyCleanup({
    installSource: env.APPFLARE_INSTALL_SOURCE,
    isAdmin,
    dismissedAt: row.deploy_copy_dismissed_at,
    accountId: row.account_id,
    workerName: row.worker_name,
  });
}

/** Hides the row for every admin of this manager. Idempotent. */
export async function dismissDeployCopyCleanup(
  env: DeployCopyEnv,
  now: Date = new Date(),
): Promise<void> {
  const db = createDb(env.DB);
  const row = await readSettings(db, [SETTING.deployCopyDismissedAt]);
  if (row.deploy_copy_dismissed_at !== undefined) return;
  await writeSettings(db, { [SETTING.deployCopyDismissedAt]: now.toISOString() }, now);
}
