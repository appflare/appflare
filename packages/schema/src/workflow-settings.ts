import { z } from "zod";
import type { ArtifactWorker } from "./artifact";
import type { Plan } from "./catalog";
import { definesWorkflow } from "./workers";

/**
 * Settings an app's wrangler config gives a Workflow it defines, beside its
 * binding: a `workflows[]` entry's `limits`, `concurrency`, `schedules` and
 * `default_retention`, every field wrangler 4.136.2 (and 4.147.0) takes
 * there besides the binding itself. None of them is part of the Worker's
 * upload: `wrangler deploy` sends them in the `PUT /workflows/{name}` that
 * creates or updates the Workflow once the Worker is uploaded, each only
 * when the config sets it, and the manager sends them in the same call.
 *
 * Names and units are wrangler's, which are the API's. `schedules` is
 * always a list here, where wrangler also takes one string; the call sends
 * each cron expression as `{ cron }`. Values are checked as wrangler checks
 * them; Cloudflare checks the rest when the Workflow is created (on Workers
 * Free it refuses more than 1,024 steps or 100 instances at once, and any
 * schedule).
 */

/**
 * How long Cloudflare keeps a finished instance: milliseconds, or a duration
 * such as `"3 days"`, which Cloudflare reads.
 */
export const workflowRetentionSchema = z.union([z.int().min(1), z.string().min(1)]);
export type WorkflowRetention = z.infer<typeof workflowRetentionSchema>;

/** The settings of one Workflow; see the module comment. */
export const workflowSettingsSchema = z.object({
  /** `steps`: the most steps an instance may run. */
  limits: z.object({ steps: z.int().min(1).optional() }).optional(),
  /** `limit`: the most instances that run at once. */
  concurrency: z.object({ limit: z.int().min(1).optional() }).optional(),
  /** Cron expressions, each starting an instance when it fires. Workers Paid only. */
  schedules: z.array(z.string().min(1)).min(1).optional(),
  /** How long finished instances are kept, unless an instance sets its own. */
  default_retention: z
    .object({
      success_retention: workflowRetentionSchema.optional(),
      error_retention: workflowRetentionSchema.optional(),
    })
    .optional(),
});
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

/** The fields of {@link workflowSettingsSchema}, as a wrangler config names them. */
export const WORKFLOW_SETTING_KEYS = [
  "limits",
  "concurrency",
  "schedules",
  "default_retention",
] as const;

/**
 * An artifact Worker's `workflowSettings`: the settings of each Workflow the
 * Worker defines, by the name of its `workflow` binding.
 */
export const workflowSettingsByBindingSchema = z.record(z.string().min(1), workflowSettingsSchema);
export type WorkflowSettingsByBinding = z.infer<typeof workflowSettingsByBindingSchema>;

/**
 * What is wrong with a Worker's `workflowSettings`, as sentences; empty when
 * nothing is. Each entry must be keyed by a `workflow` binding of the Worker
 * that defines its Workflow (`definesWorkflow`): a binding that runs another
 * Worker's Workflow has no settings to give it, and wrangler refuses them
 * there.
 */
export function workflowSettingsProblems(
  worker: Pick<ArtifactWorker, "bindings" | "workflowSettings">,
): string[] {
  const problems: string[] = [];
  for (const binding of Object.keys(worker.workflowSettings ?? {})) {
    const bound = worker.bindings.find((b) => b.type === "workflow" && b.name === binding);
    if (bound === undefined) {
      problems.push(
        `Workflow settings are recorded for ${binding}, but the Worker has no Workflow binding by that name.`,
      );
    } else if (!definesWorkflow(bound)) {
      problems.push(
        `Workflow settings are recorded for ${binding}, which runs a Workflow another Worker defines; settings belong to the Worker that defines it.`,
      );
    }
  }
  return problems;
}

/**
 * Why the Workflow settings of an app's Workers need the catalog manifest to
 * say `plan: "paid"`, as a sentence, or null when they do not or it does.
 * Cloudflare runs a Workflow on a schedule only on Workers Paid: on Workers
 * Free the call that creates it is refused with code 10208
 * (`cron_requires_paid_plan`, seen live), so an app with one is a Workers
 * Paid app, and the install and update plan gates ask the admin to confirm
 * it.
 */
export function scheduledWorkflowPlanProblem(
  workers: ReadonlyArray<Pick<ArtifactWorker, "workflowSettings">>,
  plan: Plan,
): string | null {
  if (plan === "paid") return null;
  const scheduled = workers.flatMap((w) =>
    Object.entries(w.workflowSettings ?? {})
      .filter(([, settings]) => settings.schedules !== undefined)
      .map(([binding]) => binding),
  );
  if (scheduled.length === 0) return null;
  return (
    `the Workflow ${scheduled.length === 1 ? "binding" : "bindings"} ${scheduled.join(", ")} ` +
    `${scheduled.length === 1 ? "runs its Workflow" : "run their Workflows"} on a schedule, which Cloudflare offers only on Workers Paid; ` +
    'set "plan": "paid" in the catalog manifest'
  );
}
