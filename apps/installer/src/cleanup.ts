import { type CloudflareClient, type FetchLike, isWorkflowNotFound } from "@appflare/cf-api";
import { type Budget, BudgetExceededError } from "./budget";
import { CONNECT_AGAIN, classifyCloudflareError, errorCodes, isNotFound } from "./cloudflare";
import type { InstallationRow } from "./db/schema";
import { InstallerError } from "./http";
import { logError, logEvent } from "./log";
import { createdByAttempt, kvByAttempt } from "./ownership";
import { probeHandoff } from "./proof";
import { type Database, deleteRecord, type RecordPatch, updateRecord } from "./records";

/**
 * Removing an unfinished installation: only what its record says it created
 * (by recorded id, or by the same rule the deploy steps use to recognise a
 * create whose answer was lost), in an order Cloudflare accepts: the domain,
 * the Workflow (Cloudflare keeps it when its Worker goes), the Worker, then
 * its storage. Then the record. Each request does what fits its budget and
 * the deploy page asks again while the answer is `running`.
 */

export const CLEANUP_IDS = [
  "domain",
  "workflow",
  "worker",
  "storage",
  "database",
  "record",
] as const;
export type CleanupId = (typeof CLEANUP_IDS)[number];

const LABELS: Record<CleanupId, string> = {
  domain: "Disconnect the domain",
  workflow: "Remove the background jobs",
  worker: "Remove the Appflare Worker",
  storage: "Remove the key-value storage",
  database: "Remove the database",
  record: "Forget the installation",
};

export interface CleanupResponse {
  status: "running" | "waiting" | "removed" | "failed";
  step: { id: CleanupId; label: string };
  done: number;
  total: number;
  retryAfterMs?: number;
  message?: string;
}

/** Subrequests the largest removal makes (a list and a delete), plus room. */
const PER_REMOVAL = 3;

/** Whether the record may still hold the resource `id` (recorded, or a create whose answer may be lost). */
function pending(record: InstallationRow, id: CleanupId): boolean {
  switch (id) {
    case "domain":
      return record.domain_id !== null;
    case "workflow":
      return record.workflow_created;
    case "worker":
      return record.worker_created || record.worker_attempt_at !== null;
    case "storage":
      return record.kv_id !== null || record.kv_attempt_at !== null;
    case "database":
      return record.d1_id !== null || record.d1_attempt_at !== null;
    case "record":
      return true;
  }
}

/** Removes one resource; returns what to write to the record once it is gone. */
async function remove(
  api: CloudflareClient,
  record: InstallationRow,
  id: CleanupId,
  now: number,
  /** What was found under the installation's names but is not its own, in words. */
  left: string[],
): Promise<RecordPatch> {
  switch (id) {
    case "domain": {
      const domainId = record.domain_id;
      if (domainId !== null && record.hostname !== null) {
        const found = (await api.workerDomains.listDomains({ hostname: record.hostname })).find(
          (d) => d.id === domainId,
        );
        // A domain that now serves another Worker is not this installation's any more.
        if (found !== undefined && found.service === record.worker_name) {
          await ignoreMissing(() => api.workerDomains.detachDomain(domainId));
        }
      }
      return { domain_id: null };
    }
    case "workflow": {
      try {
        const workflow = await api.workflows.getWorkflow(record.workflow_name);
        if (workflow.script_name === record.worker_name) {
          await ignoreMissing(() => api.workflows.deleteWorkflow(record.workflow_name));
        }
      } catch (error) {
        if (!isWorkflowNotFound(error)) throw error;
      }
      return { workflow_created: false };
    }
    case "worker": {
      let ours = record.worker_created;
      if (!ours) {
        const script = (await api.workers.listScripts()).find((s) => s.id === record.worker_name);
        ours =
          script !== undefined && createdByAttempt(script.created_on, record.worker_attempt_at);
        if (script !== undefined && !ours) {
          left.push(`the Worker "${record.worker_name}", which this installation did not make`);
        }
      }
      if (ours) await ignoreMissing(() => api.workers.deleteScript(record.worker_name));
      return { worker_created: false, worker_attempt_at: null };
    }
    case "storage": {
      let kvId = record.kv_id;
      if (kvId === null) {
        const sameTitle = (await api.kv.listNamespaces()).filter(
          (n) => n.title === record.kv_title,
        );
        if (kvByAttempt(sameTitle.length, record.kv_attempt_at, now)) {
          kvId = sameTitle[0]?.id ?? null;
        } else if (sameTitle.length > 0) {
          left.push(
            `the KV namespace "${record.kv_title}", which this installation cannot tell it made`,
          );
        }
      }
      if (kvId !== null) await ignoreMissing(() => api.kv.deleteNamespace(kvId));
      return { kv_id: null, kv_attempt_at: null };
    }
    case "database": {
      let d1Id = record.d1_id;
      if (d1Id === null) {
        const found = (await api.d1.listDatabases()).find((d) => d.name === record.d1_name);
        if (found !== undefined && createdByAttempt(found.created_at, record.d1_attempt_at)) {
          d1Id = found.uuid;
        } else if (found !== undefined) {
          left.push(`the D1 database "${record.d1_name}", which this installation did not make`);
        }
      }
      if (d1Id !== null) await ignoreMissing(() => api.d1.deleteDatabase(d1Id));
      return { d1_id: null, d1_attempt_at: null };
    }
    case "record":
      return {};
  }
}

async function ignoreMissing(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function response(record: InstallationRow, extra: Partial<CleanupResponse> = {}): CleanupResponse {
  const id = CLEANUP_IDS.find((c) => pending(record, c)) ?? "record";
  return {
    status: "running",
    step: { id, label: LABELS[id] },
    done: CLEANUP_IDS.indexOf(id),
    total: CLEANUP_IDS.length,
    ...extra,
  };
}

export interface CleanupDeps {
  db: Database;
  api: CloudflareClient;
  fetch: FetchLike;
  budget: Budget;
  now: number;
}

/**
 * Refuses to remove a manager that already has an owner: it is finished,
 * and its owner removes it from its own settings. Asked only before the
 * removal starts; an address that does not answer does not stop it.
 */
async function refuseFinished(record: InstallationRow, deps: CleanupDeps): Promise<void> {
  if (record.status === "removing" || !record.worker_created) return;
  const probe = await probeHandoff(deps.fetch, record.address, record.handoff_hash);
  if (probe.kind === "verified" && probe.state === "done") {
    throw new InstallerError(
      409,
      "already_set_up",
      "This Appflare already has an owner, so it is not removed from here. Its owner can remove it in Appflare's own settings.",
    );
  }
}

export async function runCleanup(
  record: InstallationRow,
  deps: CleanupDeps,
): Promise<CleanupResponse> {
  await refuseFinished(record, deps);
  const current = { ...record };
  const save = async (patch: RecordPatch) => {
    Object.assign(current, patch);
    await updateRecord(deps.db, record.id, patch, deps.now);
  };
  if (current.status !== "removing") await save({ status: "removing", message: null });

  for (const id of CLEANUP_IDS) {
    if (!pending(current, id)) continue;
    if (id === "record") {
      await deleteRecord(deps.db, record.id);
      logEvent("removed");
      return {
        ...response(current),
        status: "removed",
        done: CLEANUP_IDS.length,
        ...(current.message === null ? {} : { message: current.message }),
      };
    }
    if (deps.budget.remaining < PER_REMOVAL) return response(current);
    try {
      const left: string[] = [];
      const patch = await remove(deps.api, current, id, deps.now, left);
      if (left.length > 0) {
        // Kept on the record so the last answer can say it, whichever request removes the record.
        const note = `Left in place: ${left.join("; ")}.`;
        patch.message = current.message === null ? note : `${current.message} ${note}`;
      }
      await save(patch);
    } catch (error) {
      if (error instanceof BudgetExceededError) return response(current);
      const kind = classifyCloudflareError(error);
      logError("cleanup_error", { step: id, kind, codes: errorCodes(error) });
      if (kind === "auth") throw new InstallerError(401, "cloudflare_auth", CONNECT_AGAIN);
      if (kind === "transient") {
        return response(current, {
          status: "waiting",
          retryAfterMs: 5_000,
          message: "Cloudflare is busy. Trying again shortly.",
        });
      }
      return response(current, {
        status: "failed",
        message: `Cloudflare did not allow this step: ${LABELS[id]}. Try again, or remove what is left in the Cloudflare dashboard.`,
      });
    }
  }
  return response(current);
}
