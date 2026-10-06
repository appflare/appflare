import type { Database } from "../db/client";
import { settings } from "../db/schema";
import { deleteSettings, readSettings, SETTING } from "../db/settings";
import { sandboxBinding } from "./binding";

/**
 * Whether the sandbox Worker was deleted while Appflare's own Worker still
 * binds `SANDBOX` to it, as D1 records it. Deleting the sandbox Worker leaves
 * that binding in place, pointing at nothing, until a disconnect removes it
 * (the disable job does so last), so the binding's presence alone would read
 * as on. The pages that show whether sandbox builds are on read this record
 * instead of asking Cloudflare on every view.
 *
 * Set by the disable job once the sandbox Worker is gone, and by any live
 * check that finds the binding pointing at a deleted Worker (which covers a
 * disable left unfinished by a version that did not record it). Cleared when
 * connecting, enabling or disconnecting finishes, when a self-update
 * promotes a new version (which binds `SANDBOX` only to a sandbox Worker the
 * account has), and when a call through the binding answers, since one to a
 * deleted Worker never does.
 *
 * A live check and a job can race: a check may mark or clear the record one
 * statement after a job cleared or marked it. The next live check corrects it.
 */

/** Records the dead binding; keeps the time it was first found. */
export async function markSandboxWorkerDeleted(
  db: Database,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(settings)
    .values({ key: SETTING.sandboxWorkerDeleted, value: now.toISOString(), updated_at: now })
    .onConflictDoNothing();
}

export async function clearSandboxWorkerDeleted(db: Database): Promise<void> {
  await deleteSettings(db, [SETTING.sandboxWorkerDeleted]);
}

/**
 * Whether the running Worker has a `SANDBOX` binding that is not recorded as
 * pointing at a deleted Worker: what the readiness pages count as sandbox
 * builds being on. One D1 read when the binding is there, none otherwise.
 */
export async function sandboxBound(env: { SANDBOX?: unknown }, db: Database): Promise<boolean> {
  if (sandboxBinding(env) === undefined) return false;
  const row = await readSettings(db, [SETTING.sandboxWorkerDeleted]);
  return row.sandbox_worker_deleted === undefined;
}

/**
 * Keeps the record in line with what a live check found: set when the
 * binding points at a deleted Worker, cleared when the sandbox Worker
 * answered through it (even with an answer of the wrong shape); untouched
 * when the check could not tell.
 */
export async function recordSandboxCheck(
  db: Database,
  status: { danglingBinding: boolean; answered: boolean },
  now: Date = new Date(),
): Promise<void> {
  if (status.danglingBinding) await markSandboxWorkerDeleted(db, now);
  else if (status.answered) await clearSandboxWorkerDeleted(db);
}
