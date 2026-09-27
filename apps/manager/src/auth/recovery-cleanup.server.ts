import type { CloudflareClient } from "@appflare/cf-api";
import { parseRecoveryCodeSecret, RECOVERY_CODE_SECRET } from "@appflare/schema";
import { removalInProgress } from "../danger/removal-flag";
import { createDb } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import { activeSelfJob } from "../jobs/self-update/guard";
import { activeVersionId } from "../jobs/update/plan";
import { accountCodeExpiry, usedAccountCode } from "./recovery.server";

/**
 * The cron's tidy-up of `RECOVERY_CODE_HASH`: once the code in it can no
 * longer be used (expired, already used, or not in the expected form), the
 * secret is deleted from the manager's Worker, as using it does. A code that
 * still works is left alone. Deleting a secret deploys a new version, so it
 * waits while a self-update or a rollback of Appflare runs, while Appflare is
 * being removed, and while a gradual deployment splits traffic.
 */

export type RecoverySecretCleanup =
  | { outcome: "none" | "kept" }
  | { outcome: "deleted"; reason: "expired" | "used" | "malformed" }
  | { outcome: "skipped"; reason: string };

export interface RecoverySecretCleanupDeps {
  d1: D1Database;
  /** `RECOVERY_CODE_HASH` of the running version. */
  secret: string | undefined;
  /** Epoch ms the running version was created. */
  since: number | undefined;
  now: Date;
  api: () => Promise<Pick<CloudflareClient, "versions" | "workers">>;
  workflows?: WorkflowLookup;
}

export async function cleanUpRecoverySecret(
  deps: RecoverySecretCleanupDeps,
): Promise<RecoverySecretCleanup> {
  if (deps.secret === undefined) return { outcome: "none" };
  const now = deps.now.getTime();
  const parsed = parseRecoveryCodeSecret(deps.secret);
  const reason =
    parsed === null
      ? "malformed"
      : accountCodeExpiry(parsed, now, deps.since) <= now
        ? "expired"
        : (await usedAccountCode(deps.d1)) === parsed.hash
          ? "used"
          : null;
  if (reason === null) return { outcome: "kept" };

  if ((await removalInProgress(deps.d1, deps.now)) !== null) {
    return { outcome: "skipped", reason: "Appflare is being removed" };
  }
  if ((await activeSelfJob(deps.d1, deps.workflows)) !== null) {
    return { outcome: "skipped", reason: "a self-update or rollback of Appflare is running" };
  }
  const { worker_name: workerName } = await readSettings(createDb(deps.d1), [SETTING.workerName]);
  if (!workerName) return { outcome: "skipped", reason: "the Worker name is not known yet" };
  const api = await deps.api();
  if (activeVersionId(await api.versions.listDeployments(workerName)) === null) {
    return { outcome: "skipped", reason: "a gradual deployment is in progress" };
  }
  await api.workers.deleteSecret(workerName, RECOVERY_CODE_SECRET);
  return { outcome: "deleted", reason };
}
