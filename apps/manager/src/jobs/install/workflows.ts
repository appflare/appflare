import { CloudflareApiError, isWorkflowCronPaidOnly, isWorkflowNotFound } from "@appflare/cf-api";
import { type ArtifactManifest, definesWorkflow } from "@appflare/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client";
import { resources } from "../../db/schema";
import { entryWorkers } from "../entry-workers";
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
    for (const binding of worker.manifest.worker.bindings) {
      if (!definesWorkflow(binding)) continue;
      const name = Object.hasOwn(names, binding.name) ? names[binding.name] : undefined;
      if (name === undefined || out.some((t) => t.name === name)) continue;
      out.push({
        binding: binding.name,
        name,
        scriptName: worker.scriptName,
        className: typeof binding.class_name === "string" ? binding.class_name : binding.name,
      });
    }
  }
  return out;
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
 * warning; the row stays without a Cloudflare id, so the app page marks it
 * and the cron's repair tries again, and the job goes on.
 *
 * Settings the app's config gives a Workflow (`limits`, `concurrency`,
 * `schedules`, `default_retention`) are not in artifacts, so Cloudflare's
 * defaults apply. Should schedules ever be sent, Cloudflare refuses them on
 * Workers Free with its own code, which is told apart as wrangler does.
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
      let created: { id: string };
      try {
        created = await cf().workflows.putWorkflow(target.name, {
          script_name: target.scriptName,
          class_name: target.className,
        });
      } catch (error) {
        const refused =
          error instanceof CloudflareApiError && error.status < 500 && error.status !== 429;
        if (!refused) throw error;
        const why = isWorkflowCronPaidOnly(error)
          ? "it runs on a schedule, which needs the Workers Paid plan"
          : errorMessage(error);
        if (opts.mode === "serving") {
          log.warn(
            `Cloudflare refused the Workflow "${target.name}" (${why}). The version serves without it, so the parts of the app that use it do not work; Appflare tries again on its next scheduled check.`,
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
        if (isWorkflowCronPaidOnly(error)) {
          throw new JobError(`the Workflow ${target.name} ${why}`);
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
        `Workflow "${target.name}" runs ${target.className} of Worker "${target.scriptName}".`,
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
