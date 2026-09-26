import { NEEDS_ADMIN_COPY, planUpdateAll } from "../auto-update/auto-update";
import {
  describeNeeds,
  readCandidateRows,
  type ScheduledUpdatesDeps,
  type ScheduledUpdatesEnv,
  startUnattendedUpdate,
  updateCandidates,
} from "../auto-update/cron.server";
import type { AppLookup } from "../catalog/merged.server";
import { installLabel } from "./display-name";
import type { UpdateAllInput, UpdateAllOutcome } from "./update-all";
import { statusRefusal, VersionActionError } from "./versions.server";

/**
 * "Update all": the automatic updates' own path, started by an admin. The
 * listed installs are judged by the cron's rules (see `planUpdateAll`), and
 * each one that may start goes through the Update button's start path with
 * no secrets and no confirmations, so an update that needs any is listed for
 * the admin instead of starting. The jobs are recorded as started by an
 * admin. Nothing throws for one install; each outcome is returned.
 */
export async function startAllUpdatesCore(
  env: ScheduledUpdatesEnv,
  deps: ScheduledUpdatesDeps,
  /** The enabled catalogs' apps, by app key. */
  listed: AppLookup,
  request: UpdateAllInput,
): Promise<UpdateAllOutcome> {
  const wanted = new Map(request.installIds.map((id, i) => [id, i]));
  const rows = (await readCandidateRows(env.DB))
    .filter((r) => wanted.has(r.id))
    .sort((a, b) => (wanted.get(a.id) ?? 0) - (wanted.get(b.id) ?? 0));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const outcome: UpdateAllOutcome = { started: [], needsInput: [], notStarted: [] };
  const candidates = await updateCandidates(env.DB, rows, listed);
  for (const decision of planUpdateAll(candidates)) {
    const row = byId.get(decision.installId);
    if (row === undefined) continue;
    const item = {
      installId: row.id,
      label: installLabel(row),
      version: decision.action === "skip" ? row.version : decision.version,
    };
    if (decision.action === "skip") {
      if (decision.reason === "limit") {
        outcome.notStarted.push({
          ...item,
          reason: "Not tried yet, to stay within one request's limits. Choose Update all again.",
        });
      } else if (decision.reason === "not-installed") {
        const refusal = statusRefusal(row.status);
        if (refusal !== null) outcome.notStarted.push({ ...item, reason: refusal });
      }
      // Up to date or no longer in the catalog: nothing to update.
      continue;
    }
    if (decision.action === "needs-admin") {
      outcome.needsInput.push({ ...item, reason: NEEDS_ADMIN_COPY[decision.reason] });
      continue;
    }
    try {
      const result = await startUnattendedUpdate(env, deps, listed, row.id, "admin");
      if ("jobId" in result) {
        outcome.started.push({ ...item, jobId: result.jobId });
      } else {
        outcome.needsInput.push({ ...item, reason: `It needs ${describeNeeds(result)}.` });
      }
    } catch (error) {
      if (!(error instanceof VersionActionError)) throw error;
      outcome.notStarted.push({ ...item, reason: error.message });
    }
  }
  return outcome;
}
