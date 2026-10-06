import {
  CloudflareApiError,
  isWorkflowCronPaidOnly,
  isWorkflowNotFound,
  type WorkflowInfo,
  type WorkflowPutBody,
} from "@appflare/cf-api";
import {
  type ArtifactManifest,
  definesWorkflow,
  type WorkflowRetention,
  type WorkflowSettings,
} from "@appflare/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import { resources } from "../../db/schema";
import { entryWorkers, parseStoredManifest } from "../entry-workers";
import { errorMessage, JobError, type JobSteps } from "../steps";
import { resourceId } from "./phases";

/**
 * Workflows of an installed app. Uploading a Worker never creates the
 * Workflows it defines: its `workflow` binding only names one, and binding
 * `create()` fails with "workflow.not_found" until `PUT /workflows/{name}`
 * says which script and class run it. `wrangler deploy` makes that call after
 * every upload, for each Workflow the Worker defines (no `script_name`, or
 * its own); a binding that names another Worker's Workflow gets no call. The
 * jobs do the same, once the Worker that defines the Workflow serves the
 * version with its class: install after each upload, update and rollback
 * after promotion. The call is idempotent, so it doubles as the update.
 *
 * The call carries the settings the app's wrangler config gives the
 * Workflow (`limits`, `concurrency`, `schedules`, `default_retention`), as
 * the artifact records them for the Worker that defines it
 * (`worker.workflowSettings`), and each version's call sends its own. Each
 * call makes a new version of the Workflow, and Cloudflare puts a limit,
 * concurrency or retention the call leaves out back to its default, so an
 * update or rollback puts the Workflow on that version's settings: instances
 * started once the change takes effect (within a minute, seen live) run with
 * them, ones already started keep theirs.
 * Schedules are sent even when the version has none, as an empty list:
 * wrangler leaves them out then, which need not take off a schedule an
 * earlier version gave the Workflow.
 *
 * A Workflow the serving version no longer defines gets no call and stays,
 * as every resource does, until the uninstall deletes it. A schedule an
 * earlier version gave it would go on starting instances of a class the
 * serving version lacks, each failing, so the update and rollback take
 * that schedule off ({@link unscheduleWorkflowPhase}).
 */

/** A Workflow the app defines, as Cloudflare should have it. */
export interface WorkflowTarget {
  /** The binding of the Worker that defines it: its resource row's key. */
  binding: string;
  /** Its name in the account. */
  name: string;
  /** The installed Worker that defines it and runs its class. */
  scriptName: string;
  className: string;
  /**
   * The settings the app gives it; absent when it has none, and in a step
   * output recorded before settings were carried.
   */
  settings?: WorkflowSettings;
}

/**
 * Every Workflow the app's Workers define, each with the Worker that runs
 * it, named by `names` (Workflow binding to the install's Workflow name). A
 * binding without a name is left out, as is a second binding of one name.
 */
export function workflowTargets(
  manifest: ArtifactManifest,
  installWorkerName: string,
  names: Readonly<Record<string, string>>,
): WorkflowTarget[] {
  const out: WorkflowTarget[] = [];
  for (const worker of entryWorkers(manifest, installWorkerName)) {
    const recorded = worker.manifest.worker.workflowSettings ?? {};
    for (const binding of worker.manifest.worker.bindings) {
      if (!definesWorkflow(binding)) continue;
      const name = Object.hasOwn(names, binding.name) ? names[binding.name] : undefined;
      if (name === undefined || out.some((t) => t.name === name)) continue;
      const settings = Object.hasOwn(recorded, binding.name) ? recorded[binding.name] : undefined;
      out.push({
        binding: binding.name,
        name,
        scriptName: worker.scriptName,
        className: typeof binding.class_name === "string" ? binding.class_name : binding.name,
        ...(settings === undefined ? {} : { settings }),
      });
    }
  }
  return out;
}

/**
 * The `PUT /workflows/{name}` body for `target`: its Worker and class, and
 * each setting the app gives it, shaped as wrangler 4.136.2 sends them
 * (`triggersDeploy`): only those set, each cron expression as `{ cron }`.
 * Unlike wrangler, `schedules` is always there, empty when the app gives
 * none (Workers Free takes an empty list), so a call never leaves a
 * schedule of an earlier version in place.
 */
export function workflowPutBody(target: WorkflowTarget): WorkflowPutBody {
  const { limits, concurrency, schedules, default_retention } = target.settings ?? {};
  return {
    script_name: target.scriptName,
    class_name: target.className,
    ...(limits === undefined ? {} : { limits }),
    ...(concurrency === undefined ? {} : { concurrency }),
    schedules: (schedules ?? []).map((cron) => ({ cron })),
    ...(default_retention === undefined ? {} : { default_retention }),
  };
}

const RETENTION_UNITS: ReadonlyArray<[ms: number, unit: string]> = [
  [86_400_000, "day"],
  [3_600_000, "hour"],
  [60_000, "minute"],
  [1_000, "second"],
];

/**
 * A retention as a log line reads it: milliseconds in the largest whole unit
 * (`3600000` is "1 hour", `5400000` "90 minutes"), a duration string as
 * written.
 */
export function retentionText(value: WorkflowRetention): string {
  if (typeof value === "string") return value;
  for (const [ms, unit] of RETENTION_UNITS) {
    if (value % ms === 0) {
      const n = value / ms;
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  return `${value} ms`;
}

/**
 * The settings the app gives a Workflow, as a job log names them ("at most
 * 500 steps, 3 instances at once"), or null when it has none.
 */
export function describeWorkflowSettings(settings: WorkflowSettings | undefined): string | null {
  if (settings === undefined) return null;
  const parts: string[] = [];
  if (settings.limits?.steps !== undefined) parts.push(`at most ${settings.limits.steps} steps`);
  if (settings.concurrency?.limit !== undefined) {
    parts.push(`${settings.concurrency.limit} instances at once`);
  }
  if (settings.schedules !== undefined) {
    parts.push(`started on the schedule ${settings.schedules.map((c) => `"${c}"`).join(", ")}`);
  }
  const kept = settings.default_retention;
  if (kept?.success_retention !== undefined) {
    parts.push(`successful instances kept ${retentionText(kept.success_retention)}`);
  }
  if (kept?.error_retention !== undefined) {
    parts.push(`failed instances kept ${retentionText(kept.error_retention)}`);
  }
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * Whether `error` is Cloudflare refusing a call (a 4xx other than 429),
 * which a retry would not change.
 */
function isRefusal(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status < 500 && error.status !== 429;
}

/** The Workflows of `targets` the Worker `scriptName` defines. */
export function workflowsOf(
  targets: readonly WorkflowTarget[],
  scriptName: string,
): WorkflowTarget[] {
  return targets.filter((t) => t.scriptName === scriptName);
}

/**
 * The Worker names an install recorded (live `worker` rows): the scripts
 * whose Workflows are the install's own.
 */
export async function installWorkerNames(orm: Database, installId: string): Promise<string[]> {
  const rows = await orm
    .select({ name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        eq(resources.kind, "worker"),
        isNull(resources.deleted_at),
      ),
    );
  return rows.map((r) => r.name);
}

/**
 * Whether a Workflow that exists in the account is the install's to change:
 * it runs one of the install's Workers (or does not say which). A PUT on any
 * other would take it from its script.
 */
export function isInstallWorkflow(
  existing: { script_name?: string },
  workers: readonly string[],
): boolean {
  return existing.script_name === undefined || workers.includes(existing.script_name);
}

/** Whether the Workflow step is part of an install, or runs once a version serves. */
export type WorkflowStepMode = "install" | "serving";

/**
 * Step "create Workflow <name>" (`fresh`: new to the install) or "update
 * Workflow <name>": points the Workflow at its Worker and class with
 * `PUT /workflows/{name}`, which is idempotent, so a retried step repeats it
 * harmlessly. Every row of the Workflow gets its Cloudflare id, which is how
 * the app page and the cron's repair (installs/workflow-repair.server.ts)
 * tell it exists.
 *
 * A fresh one is recorded first, under its binding with its name (a row of
 * that binding an earlier version left deleted is taken over and renamed),
 * as the Worker is before its upload: a call whose answer is lost may still
 * have created it, and the uninstall deletes Workflows by name. Its name was
 * checked free before anything was created.
 *
 * A kept one is the install's by its record, but a row without a Cloudflare
 * id (left by managers up to 0.2.0, which never created one) proves nothing:
 * it is looked up first, and one that runs a script the install does not
 * have is left alone. It is found by name: under a renamed binding its row
 * keeps the binding it was recorded with (the row's id is made from it), and
 * the repair matches it by name too.
 *
 * `install` (the app is not live yet): a refusal fails the step, and a fresh
 * row is released, since nothing was created. `serving` (update and
 * rollback, after promotion): a refusal or a Workflow of another script is a
 * warning; the row is left (or put) without a Cloudflare id, so the app page
 * marks it and the cron's repair tries again, and the job goes on.
 *
 * The call carries the Workflow's settings ({@link workflowPutBody}).
 * Cloudflare refuses a schedule on Workers Free with its own code, which is
 * told apart as wrangler does; any other refusal of a Workflow with settings
 * names them, since Cloudflare's own message does not say which it refused
 * (on Workers Free it takes at most 1,024 steps and 100 instances at once).
 */
export async function putWorkflowPhase(
  steps: JobSteps,
  installId: string,
  target: WorkflowTarget,
  opts: { fresh: boolean; mode: WorkflowStepMode },
): Promise<void> {
  const id = resourceId(installId, "workflow", target.binding);
  const byName = and(
    eq(resources.install_id, installId),
    eq(resources.kind, "workflow"),
    eq(resources.name, target.name),
    isNull(resources.deleted_at),
  );
  await steps.run(
    `${opts.fresh ? "create" : "update"} Workflow ${target.name}`,
    async ({ log, cf, orm }) => {
      if (opts.fresh) {
        await orm
          .insert(resources)
          .values({
            id,
            install_id: installId,
            kind: "workflow",
            binding: target.binding,
            name: target.name,
            cf_id: null,
            created_at: new Date(steps.now()),
          })
          .onConflictDoUpdate({
            target: resources.id,
            set: { name: target.name, deleted_at: null, cf_id: null },
          });
      } else {
        const [row] = await orm.select({ cfId: resources.cf_id }).from(resources).where(byName);
        if (row !== undefined && row.cfId === null) {
          let existing: { script_name?: string } | null = null;
          try {
            existing = await cf().workflows.getWorkflow(target.name);
          } catch (error) {
            if (!isWorkflowNotFound(error)) throw error;
          }
          if (
            existing !== null &&
            !isInstallWorkflow(existing, await installWorkerNames(orm, installId))
          ) {
            const message = `A Workflow named "${target.name}" exists and runs the Worker "${existing.script_name}", which is not this app's, so Appflare leaves it alone; the app's ${target.className} does not run until it is renamed or deleted in the Cloudflare dashboard.`;
            if (opts.mode === "install") throw new JobError(message);
            log.warn(message);
            return {};
          }
        }
      }
      const settings = describeWorkflowSettings(target.settings);
      let created: { id: string };
      try {
        created = await cf().workflows.putWorkflow(target.name, workflowPutBody(target));
      } catch (error) {
        if (!isRefusal(error)) throw error;
        // As wrangler tells it apart: only a call with schedules is refused for them.
        const cronPaidOnly =
          isWorkflowCronPaidOnly(error) && target.settings?.schedules !== undefined;
        const why = cronPaidOnly
          ? "it runs on a schedule, which needs the Workers Paid plan"
          : settings === null
            ? errorMessage(error)
            : `${errorMessage(error)}; the app asks for ${settings}`;
        if (opts.mode === "serving") {
          // Without its id the app page marks it and the cron's repair tries
          // again: a kept one may still run the previous version's class.
          await orm
            .update(resources)
            .set({ cf_id: null })
            .where(opts.fresh ? eq(resources.id, id) : byName);
          log.warn(
            `Cloudflare refused the Workflow "${target.name}" (${why}). The version serves without it, so the parts of the app that use it may not work; Appflare tries again on its next scheduled check.`,
          );
          return {};
        }
        if (opts.fresh) {
          await orm
            .update(resources)
            .set({ deleted_at: new Date(steps.now()) })
            .where(and(eq(resources.id, id), isNull(resources.deleted_at)));
          log.warn(`Cloudflare refused the Workflow; no Workflow "${target.name}" was created.`);
        }
        if (cronPaidOnly) {
          throw new JobError(
            `the Workflow "${target.name}" runs on a schedule, which needs the Workers Paid plan`,
          );
        }
        if (settings !== null) {
          throw new JobError(`Cloudflare refused the Workflow "${target.name}" (${why})`);
        }
        throw error;
      }
      await orm
        .update(resources)
        .set(
          opts.fresh
            ? { name: target.name, cf_id: created.id, deleted_at: null }
            : { cf_id: created.id },
        )
        .where(opts.fresh ? eq(resources.id, id) : byName);
      log.info(
        `Workflow "${target.name}" runs ${target.className} of Worker "${target.scriptName}"${settings === null ? "" : `, ${settings}`}.`,
      );
      return {};
    },
  );
}

/** Steps that point every Workflow of `targets` at its Worker; `fresh` names those new to the install. */
export async function putWorkflowsPhase(
  steps: JobSteps,
  installId: string,
  targets: readonly WorkflowTarget[],
  fresh: (target: WorkflowTarget) => boolean,
  mode: WorkflowStepMode,
): Promise<void> {
  for (const target of targets) {
    await putWorkflowPhase(steps, installId, target, { fresh: fresh(target), mode });
  }
}

/**
 * The Workflows a stored manifest (the version serving until now) runs on a
 * schedule, named by `names` as {@link workflowTargets} names them; empty
 * when the manifest is missing or does not parse.
 */
export function scheduledWorkflowsOf(
  manifestJson: string | null,
  installWorkerName: string,
  names: Readonly<Record<string, string>>,
): WorkflowTarget[] {
  const manifest = parseStoredManifest(manifestJson);
  if (manifest === null) return [];
  return workflowTargets(manifest, installWorkerName, names).filter(
    (t) => t.settings?.schedules !== undefined,
  );
}

/**
 * The Workflows of `scheduled` ({@link scheduledWorkflowsOf} the version
 * serving until now) that `serving` (the Workflows of the version serving
 * now) does not define, matched by name.
 */
export function scheduledWorkflowsLeft(
  scheduled: readonly WorkflowTarget[],
  serving: readonly WorkflowTarget[],
): WorkflowTarget[] {
  return scheduled.filter((t) => !serving.some((s) => s.name === t.name));
}

function withoutSchedules(settings: WorkflowSettings | undefined): WorkflowSettings {
  const { schedules: _schedules, ...rest } = settings ?? {};
  return rest;
}

/** A Workflow's schedules as a log line names them, or null when it has none. */
function schedulesText(workflow: WorkflowInfo): string | null {
  const crons = (workflow.schedules ?? []).map((s) => `"${s.cron}"`);
  return crons.length === 0 ? null : crons.join(", ");
}

/**
 * Step "take Workflow <name> off its schedule", for a Workflow of
 * {@link scheduledWorkflowsLeft} once the version without it serves
 * (`version` names that version, such as "version 1.0.0"). The Workflow
 * stays on its class, which the serving version lacks, so each instance its
 * schedule starts would fail. The step reads it: one that is the install's
 * ({@link isInstallWorkflow}) and that Cloudflare lists a schedule for is
 * put on the same script, class and other settings without one, and read
 * again. A schedule Cloudflare refuses to take off or still lists is a
 * warning that says what the admin can do; the job goes on either way. A
 * version that defines the Workflow again puts its schedule back, and the
 * uninstall deletes it by name.
 */
export async function unscheduleWorkflowPhase(
  steps: JobSteps,
  installId: string,
  target: WorkflowTarget,
  version: string,
): Promise<void> {
  await steps.run(`take Workflow ${target.name} off its schedule`, async ({ log, cf, orm }) => {
    let existing: WorkflowInfo;
    try {
      existing = await cf().workflows.getWorkflow(target.name);
    } catch (error) {
      if (isWorkflowNotFound(error)) return {};
      throw error;
    }
    if (!isInstallWorkflow(existing, await installWorkerNames(orm, installId))) return {};
    const schedules = schedulesText(existing);
    if (schedules === null) return {};
    const left = `The Workflow "${target.name}" still starts on the schedule ${schedules}, but ${version} does not define it, so each instance it starts fails`;
    const advice =
      "Delete the Workflow in the Cloudflare dashboard, or update the app to a version that defines it.";
    try {
      await cf().workflows.putWorkflow(
        target.name,
        workflowPutBody({
          ...target,
          scriptName: existing.script_name ?? target.scriptName,
          className: existing.class_name ?? target.className,
          settings: withoutSchedules(target.settings),
        }),
      );
      if (schedulesText(await cf().workflows.getWorkflow(target.name)) !== null) {
        log.warn(
          `${left}: Cloudflare still lists the schedule after Appflare took it off. ${advice}`,
        );
        return {};
      }
    } catch (error) {
      if (!isRefusal(error)) throw error;
      log.warn(
        `${left}: Cloudflare refused to take the schedule off (${errorMessage(error)}). ${advice}`,
      );
      return {};
    }
    log.info(
      `Appflare took the Workflow "${target.name}" off its schedule ${schedules}: ${version} does not define it, so each instance the schedule started would fail. A version that defines it puts the schedule back.`,
    );
    return {};
  });
}
