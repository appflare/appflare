import { type CloudflareClient, isWorkflowNotFound } from "@appflare/cf-api";
import { type ArtifactManifest, artifactManifestSchema } from "@appflare/schema";
import { eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { resources } from "../db/schema";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { entryBindings } from "../jobs/entry-workers";
import { planBindings } from "../jobs/install/bindings";
import {
  installWorkerNames,
  isInstallWorkflow,
  type WorkflowTarget,
  workflowTargets,
} from "../jobs/install/workflows";

/**
 * Creates the Workflows of installed apps that do not exist in Cloudflare.
 * Managers up to 0.2.0 recorded each Workflow an app defines but never
 * created it (they took the Worker's upload for the call that creates it), so
 * the app's binding failed on every `create()`. A Workflow the jobs created
 * or found carries its Cloudflare id; this looks at the recorded ones that do
 * not, of apps that are installed (not mid-job): one it finds in Cloudflare
 * gets its id, one that is missing is created as the installed version
 * defines it (its Worker and class), and one that version no longer defines
 * is marked gone, since nothing runs it. What it could not fix stays without
 * an id, which the app page shows, and is tried again the next day.
 *
 * Runs from the cron at most once per UTC day once there is nothing left to
 * fix, through the `repairWorkflows` notification unit (its own invocation
 * and subrequest budget over `SELF`), and never fails the run.
 */

/** Workflows looked at per call: each one is up to two Cloudflare calls and one D1 write. */
export const WORKFLOW_REPAIRS_PER_RUN = 10;

export interface WorkflowRepairReport {
  /** Workflows looked at. */
  checked: number;
  /** Created now (they did not exist). */
  created: string[];
  /** Already in Cloudflare; their ids are recorded now. */
  found: string[];
  /** Not defined by the installed version any more, and not in Cloudflare: marked gone. */
  unused: string[];
  /** Could not be checked or created, with why. */
  failed: Array<{ name: string; reason: string }>;
}

interface Candidate {
  id: string;
  install_id: string;
  binding: string | null;
  name: string;
  worker_name: string;
  manifest_json: string | null;
}

/** An install no job is changing: installed, with no job queued or running. */
const SETTLED = `i.status = 'installed' AND NOT EXISTS (
    SELECT 1 FROM jobs j WHERE j.install_id = i.id AND j.status IN ('queued', 'running'))`;

const CANDIDATES_SQL = `SELECT r.id, r.install_id, r.binding, r.name, i.worker_name, i.manifest_json
  FROM resources r JOIN installs i ON i.id = r.install_id
  WHERE r.kind = 'workflow' AND r.cf_id IS NULL AND r.deleted_at IS NULL
    AND r.retained_at IS NULL AND r.managed_by = 'appflare' AND ${SETTLED}
  ORDER BY r.rowid`;

/**
 * The Workflow a row stands for in the installed version: by its binding, or
 * by its name (an update that renamed the binding kept the row and its name).
 */
function targetOf(manifest: ArtifactManifest, row: Candidate): WorkflowTarget | undefined {
  if (row.binding !== null) {
    const byBinding = workflowTargets(manifest, row.worker_name, { [row.binding]: row.name })[0];
    if (byBinding !== undefined) return byBinding;
  }
  const planned = planBindings(row.worker_name, entryBindings(manifest)).workflows;
  return workflowTargets(
    manifest,
    row.worker_name,
    Object.fromEntries(planned.map((w) => [w.binding, w.name])),
  ).find((t) => t.name === row.name);
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Whether the cron should run the repair: something is left to look at and
 * it did not finish a run today. One or two D1 reads, no Cloudflare call.
 */
export async function workflowRepairNeeded(
  d1: D1Database,
  now: Date = new Date(),
): Promise<boolean> {
  const done = await readSettings(createDb(d1), [SETTING.workflowRepairDay]);
  if (done.workflow_repair_day === utcDay(now)) return false;
  const row = await d1.prepare(`${CANDIDATES_SQL} LIMIT 1`).first();
  return row !== null;
}

/** The repair itself: see the module comment. Throws only when D1 or the client cannot be reached. */
export async function repairWorkflows(deps: {
  db: D1Database;
  api: () => Promise<CloudflareClient>;
  now?: () => Date;
}): Promise<WorkflowRepairReport> {
  const now = deps.now ?? (() => new Date());
  const report: WorkflowRepairReport = {
    checked: 0,
    created: [],
    found: [],
    unused: [],
    failed: [],
  };
  const { results } = await deps.db
    .prepare(`${CANDIDATES_SQL} LIMIT ?1`)
    .bind(WORKFLOW_REPAIRS_PER_RUN)
    .all<Candidate>();
  if (results.length === 0) {
    await writeSettings(createDb(deps.db), { [SETTING.workflowRepairDay]: utcDay(now()) });
    return report;
  }
  const api = await deps.api();
  const orm = createDb(deps.db);
  const setId = (id: string, cfId: string) =>
    orm.update(resources).set({ cf_id: cfId }).where(eq(resources.id, id));
  for (const row of results) {
    report.checked += 1;
    try {
      const parsed =
        row.manifest_json === null
          ? null
          : artifactManifestSchema.safeParse(JSON.parse(row.manifest_json));
      const target = parsed?.success === true ? targetOf(parsed.data, row) : undefined;
      let existing: { id: string; script_name?: string } | null = null;
      try {
        existing = await api.workflows.getWorkflow(row.name);
      } catch (error) {
        if (!isWorkflowNotFound(error)) throw error;
      }
      if (existing !== null) {
        if (!isInstallWorkflow(existing, await installWorkerNames(orm, row.install_id))) {
          report.failed.push({
            name: row.name,
            reason: `it runs the Worker "${existing.script_name}", which is not this app's`,
          });
          continue;
        }
        await setId(row.id, existing.id);
        report.found.push(row.name);
        continue;
      }
      if (parsed === null || !parsed.success) {
        report.failed.push({ name: row.name, reason: "the installed version is not readable" });
        continue;
      }
      if (target === undefined) {
        await orm.update(resources).set({ deleted_at: now() }).where(eq(resources.id, row.id));
        report.unused.push(row.name);
        continue;
      }
      // An uninstall or another job may have started since the list was read.
      const settled = await deps.db
        .prepare(`SELECT 1 FROM installs i WHERE i.id = ?1 AND ${SETTLED}`)
        .bind(row.install_id)
        .first();
      if (settled === null) {
        report.failed.push({ name: row.name, reason: "a job is changing the app" });
        continue;
      }
      const created = await api.workflows.putWorkflow(target.name, {
        script_name: target.scriptName,
        class_name: target.className,
      });
      await setId(row.id, created.id);
      report.created.push(row.name);
    } catch (error) {
      report.failed.push({
        name: row.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Done for today, unless this run stopped at its limit having fixed some:
  // the next run goes on with the rest.
  const fixed = report.created.length + report.found.length + report.unused.length;
  if (results.length < WORKFLOW_REPAIRS_PER_RUN || fixed === 0) {
    await writeSettings(createDb(deps.db), { [SETTING.workflowRepairDay]: utcDay(now()) });
  }
  return report;
}

/** The cron's log line for a report, or null when there is nothing to say. */
export function workflowRepairLog(report: WorkflowRepairReport): string | null {
  if (report.checked === 0) return null;
  const parts = [`${report.checked} checked`];
  if (report.created.length > 0) parts.push(`created ${report.created.join(", ")}`);
  if (report.found.length > 0) parts.push(`found ${report.found.join(", ")}`);
  if (report.unused.length > 0) parts.push(`no longer used ${report.unused.join(", ")}`);
  if (report.failed.length > 0) {
    parts.push(`failed ${report.failed.map((f) => `${f.name} (${f.reason})`).join("; ")}`);
  }
  return `workflows: ${parts.join(", ")}`;
}
