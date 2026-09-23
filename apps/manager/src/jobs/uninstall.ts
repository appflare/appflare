import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError, isAddressableObjectKey } from "@appflare/cf-api";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import {
  DATA_RESOURCE_KINDS,
  type DataResourceKind,
  WORKER_BOUND_KINDS,
} from "../installs/resource-kinds";
import { deleteResource, RESOURCE_LABEL } from "./install/resources";
import type { JobContext } from "./run-job";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, isNotFound, JobError } from "./steps";

/**
 * The `uninstall` job. One API call per step, retried on 429/5xx like the
 * install; a 404 means the object is already gone and counts as deleted, so a
 * retried or repeated uninstall converges. Order: the Worker first (with
 * `?force=true`, which also removes its cron triggers, workers.dev route,
 * secrets, Durable Objects, and Workflows), then each ticked data resource.
 * The Worker is deleted only when this install recorded it: an install that
 * failed before its upload never owned a Worker of that name, and the account
 * may hold someone else's. An R2 bucket must be empty before it can be
 * deleted, so its objects are listed and deleted a page per step first.
 * Resources the admin kept were marked retained when the uninstall started
 * and are never touched.
 *
 * On failure the job records `<step>: <message>` and the install stays
 * `uninstalling`, so the install page offers a retry for what is left.
 */

/** The Workflow payload `startUninstall` creates. */
export const uninstallJobParams = z.object({
  kind: z.literal("uninstall"),
  jobId: z.string().min(1),
  installId: z.string().min(1),
  /** Ids of the data resources to delete. */
  deleteResources: z.array(z.string().min(1)).max(500),
});
export type UninstallJobParams = z.infer<typeof uninstallJobParams>;

/**
 * R2 objects deleted per step: one list call plus one delete per object, well
 * inside the per-invocation subrequest budget.
 */
export const R2_OBJECTS_PER_STEP = 30;

/**
 * Pages of R2 objects one run deletes (6,000 objects) before it stops and asks
 * for a retry, which continues where it stopped. This keeps a run well inside
 * the Workflows limit on steps per instance.
 */
export const R2_MAX_PAGES_PER_RUN = 200;

interface Target {
  id: string;
  kind: DataResourceKind;
  name: string;
  cfId: string | null;
}

export async function runUninstall(ctx: JobContext): Promise<void> {
  const parsed = uninstallJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid uninstall job payload");
  const params = parsed.data;
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;

  try {
    const started = await run("start", 0, async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      const [install] = await orm
        .select({ workerName: installs.worker_name })
        .from(installs)
        .where(eq(installs.id, params.installId))
        .limit(1);
      if (install === undefined) throw new JobError("the install no longer exists");
      const live = await orm
        .select()
        .from(resources)
        .where(and(eq(resources.install_id, params.installId), isNull(resources.deleted_at)))
        .orderBy(sql`rowid`);
      const wanted = new Set(params.deleteResources);
      const targets: Target[] = [];
      for (const r of live) {
        if (r.retained_at !== null || !wanted.has(r.id)) continue;
        const kind = DATA_RESOURCE_KINDS.find((k) => k === r.kind);
        if (kind !== undefined) targets.push({ id: r.id, kind, name: r.name, cfId: r.cf_id });
      }
      const kept = live.filter((r) => r.retained_at !== null).map((r) => r.name);
      // "live": recorded and not deleted yet; "deleted": an earlier run deleted
      // it; "none": this install never recorded a Worker.
      let worker: "live" | "deleted" | "none" = "none";
      if (live.some((r) => r.kind === "worker")) worker = "live";
      else {
        const [anyWorker] = await orm
          .select({ id: resources.id })
          .from(resources)
          .where(and(eq(resources.install_id, params.installId), eq(resources.kind, "worker")))
          .limit(1);
        if (anyWorker !== undefined) worker = "deleted";
      }
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      log.info(
        `Uninstalling Worker "${install.workerName}". ` +
          (targets.length > 0
            ? `Deleting: ${targets.map((t) => `${RESOURCE_LABEL[t.kind]} ${t.name}`).join(", ")}. `
            : "No data resources to delete. ") +
          (kept.length > 0 ? `Keeping: ${kept.join(", ")}.` : "Keeping nothing."),
      );
      return {
        workerName: install.workerName,
        accountId: settings.account_id,
        targets,
        kept,
        worker,
      };
    });
    steps.setAccountId(started.accountId);
    const { workerName } = started;

    const workerStep =
      started.worker === "live" ? `delete Worker ${workerName}` : `skip Worker ${workerName}`;
    await run(workerStep, started.worker === "live" ? 1 : 0, async ({ log, cf, orm }) => {
      if (started.worker === "live") {
        try {
          await cf().workers.deleteScript(workerName, { force: true });
          log.info(
            `Deleted Worker "${workerName}" with its routes, cron triggers, secrets, Durable Objects, and Workflows.`,
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
          log.info(`Worker "${workerName}" was already gone.`);
        }
      } else if (started.worker === "deleted") {
        log.info(`Worker "${workerName}" was deleted by an earlier run.`);
      } else {
        // Anything bound to a Worker that was never uploaded does not exist either.
        log.info(
          `No Worker is recorded for this install; skipping. A Worker named "${workerName}" in the account is not this install's and stays untouched.`,
        );
      }
      await orm
        .update(resources)
        .set({ deleted_at: new Date(now()) })
        .where(
          and(
            eq(resources.install_id, params.installId),
            isNull(resources.deleted_at),
            inArray(resources.kind, [...WORKER_BOUND_KINDS]),
          ),
        );
      return {};
    });

    for (const target of started.targets) {
      const label = RESOURCE_LABEL[target.kind];
      if (target.kind === "r2") {
        const bucket = target.cfId ?? target.name;
        // Deleted objects drop out of the listing, so every page lists from the
        // start again. A first key seen twice means a delete did not take.
        let previousFirst: string | null = null;
        for (let page = 1; ; page++) {
          if (page > R2_MAX_PAGES_PER_RUN) {
            steps.current = `empty ${label} ${target.name}`;
            throw new JobError(
              `deleted ${R2_MAX_PAGES_PER_RUN * R2_OBJECTS_PER_STEP} objects from ${target.name} and more remain; retry the uninstall to continue`,
            );
          }
          const emptied = await run(
            `empty ${label} ${target.name} page ${page}`,
            1 + R2_OBJECTS_PER_STEP,
            async ({ log, cf }) => {
              const api = cf();
              let listed: Awaited<ReturnType<typeof api.r2.listObjects>>;
              try {
                listed = await api.r2.listObjects(bucket, { perPage: R2_OBJECTS_PER_STEP });
              } catch (error) {
                if (!isNotFound(error)) throw error;
                log.info(`${label} "${target.name}" was already gone.`);
                return { more: false, first: null };
              }
              const first = listed.items[0]?.key ?? null;
              if (first !== null && first === previousFirst) {
                throw new JobError(
                  `the object "${first}" is still listed after it was deleted; retry the uninstall in a minute`,
                );
              }
              const unreachable = listed.items.find((o) => !isAddressableObjectKey(o.key));
              if (unreachable !== undefined) {
                throw new JobError(
                  `the object "${unreachable.key}" cannot be deleted through the Cloudflare API because its key has a "." or ".." path segment; delete it with the S3 API, or retry the uninstall and keep this bucket`,
                );
              }
              for (const object of listed.items) {
                try {
                  await api.r2.deleteObject(bucket, object.key);
                } catch (error) {
                  if (!isNotFound(error)) throw error;
                }
              }
              log.info(
                listed.items.length === 0
                  ? `${label} "${target.name}" is empty.`
                  : `Deleted ${listed.items.length} object(s) from ${label} "${target.name}".`,
              );
              return { more: listed.items.length > 0 && listed.cursor !== null, first };
            },
          );
          if (!emptied.more) break;
          previousFirst = emptied.first;
        }
      }

      await run(`delete ${label} ${target.name}`, 1, async ({ log, cf, orm }) => {
        try {
          if (await deleteResource(cf(), target)) log.info(`Deleted ${label} "${target.name}".`);
          else {
            log.warn(
              `No Cloudflare id is recorded for ${label} "${target.name}", so it cannot be addressed; marked deleted without a call. Check the Cloudflare dashboard for it.`,
            );
          }
        } catch (error) {
          if (target.kind === "r2" && error instanceof CloudflareApiError && error.status === 409) {
            // The REST API offers no way to list or abort incomplete multipart
            // uploads, which keep a bucket from being deleted.
            throw new JobError(
              `Cloudflare refused to delete the bucket (${error.message}). A bucket with incomplete multipart uploads cannot be deleted, and the Cloudflare API cannot list or abort them here; abort them with the S3 API or a lifecycle rule, or retry the uninstall and keep this bucket`,
            );
          }
          if (!isNotFound(error)) throw error;
          log.info(`${label} "${target.name}" was already gone.`);
        }
        await orm
          .update(resources)
          .set({ deleted_at: new Date(now()) })
          .where(eq(resources.id, target.id));
        return {};
      });
    }

    await run("finish", 0, async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm
          .update(installs)
          .set({ status: "uninstalled", uninstalled_at: at, updated_at: at })
          .where(eq(installs.id, params.installId)),
        orm
          .update(jobs)
          .set({ status: "succeeded", finished_at: at, error: null })
          .where(eq(jobs.id, params.jobId)),
      ]);
      const retained = await orm
        .select({ name: resources.name })
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            isNull(resources.deleted_at),
            isNotNull(resources.retained_at),
          ),
        );
      log.info(
        `Uninstalled "${workerName}".` +
          (retained.length > 0
            ? ` Kept in the account: ${retained.map((r) => r.name).join(", ")}.`
            : ""),
      );
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    await step.do("mark uninstall failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      // The install stays `uninstalling` so the install page offers a retry.
      await orm.update(installs).set({ updated_at: at }).where(eq(installs.id, params.installId));
      const log = new StepLog(now);
      log.error(
        `Uninstall failed at "${steps.current}". What was deleted stays deleted; retry the uninstall to delete the rest.`,
      );
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
