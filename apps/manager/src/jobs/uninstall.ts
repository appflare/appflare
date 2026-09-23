import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError } from "@appflare/cf-api";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import {
  type DetachOutcome,
  detachCustomDomain,
  detachMessage,
  isPermissionError,
} from "../installs/custom-domains.server";
import {
  CUSTOM_DOMAIN_KIND,
  DATA_RESOURCE_KINDS,
  type DataResourceKind,
  WORKER_BOUND_KINDS,
} from "../installs/resource-kinds";
import { deleteResource, RESOURCE_LABEL } from "./install/resources";
import type { JobContext } from "./run-job";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, isNotFound, JobError } from "./steps";
import { settleUnit } from "./units/result";
import { R2_PAGE_MAX_OBJECTS } from "./units/units";

/**
 * The `uninstall` job. One API call per step, retried on 429/5xx like the
 * install; a 404 means the object is already gone and counts as deleted, so a
 * retried or repeated uninstall converges. Order: the install's custom domains
 * first (always; they hold no data, and Cloudflare does not document that
 * deleting a Worker removes them, so they get calls of their own),
 * then the Worker (with `?force=true`, which also removes its cron triggers,
 * workers.dev route, secrets, Durable Objects, and Workflows), then each
 * ticked data resource.
 * The Worker is deleted only when this install recorded it: an install that
 * failed before its upload never owned a Worker of that name, and the account
 * may hold someone else's. An R2 bucket must be empty before it can be
 * deleted, so its objects are listed and deleted first, a page per step,
 * each page one job unit (`emptyR2Page`).
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
 * R2 objects deleted per step: one job unit lists a page and deletes each
 * object on it (one subrequest per object, plus the list call). Over `SELF`
 * the unit has an invocation of its own, so a page can be as large as a unit
 * allows.
 */
export const R2_OBJECTS_PER_STEP = R2_PAGE_MAX_OBJECTS;

/**
 * R2 objects per page when the unit runs in the job's own invocation (a
 * manager without the `SELF` binding): 31 subrequests, what a page always
 * cost there, leaving the rest of the 50 to the job's other steps.
 */
export const R2_OBJECTS_PER_LOCAL_STEP = 30;

/**
 * Pages of R2 objects one run deletes, across all buckets, before it stops
 * and asks for a retry, which continues where it stopped. Every page is one
 * call from the job's own invocation, whose subrequest limit (50 on Workers
 * Free) the whole run shares, so a run stays well inside it (see
 * units/client.ts). Without the `SELF` binding the page itself runs in the
 * job's own invocation, so a run deletes one page
 * ({@link R2_MAX_LOCAL_PAGES_PER_RUN}).
 */
export const R2_MAX_PAGES_PER_RUN = 20;

/** Pages one run deletes without the `SELF` binding. */
export const R2_MAX_LOCAL_PAGES_PER_RUN = 1;

interface Target {
  id: string;
  kind: DataResourceKind;
  name: string;
  cfId: string | null;
}

/** A recorded custom domain: `name` is the hostname, `cfId` the domain's id. */
interface DomainTarget {
  id: string;
  hostname: string;
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
    const started = await run("start", async ({ log, orm }) => {
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
      // Custom domains are never kept: they hold no data.
      const domains: DomainTarget[] = live
        .filter((r) => r.kind === CUSTOM_DOMAIN_KIND)
        .map((r) => ({ id: r.id, hostname: r.name, cfId: r.cf_id }));
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
          (domains.length > 0
            ? `Removing custom domains: ${domains.map((d) => d.hostname).join(", ")}. `
            : "") +
          (targets.length > 0
            ? `Deleting: ${targets.map((t) => `${RESOURCE_LABEL[t.kind]} ${t.name}`).join(", ")}. `
            : "No data resources to delete. ") +
          (kept.length > 0 ? `Keeping: ${kept.join(", ")}.` : "Keeping nothing."),
      );
      return {
        workerName: install.workerName,
        accountId: settings.account_id,
        targets,
        domains,
        kept,
        worker,
      };
    });
    steps.setAccountId(started.accountId);
    const { workerName } = started;

    for (const domain of started.domains) {
      await run(`remove custom domain ${domain.hostname}`, async ({ log, cf, orm }) => {
        let outcome: DetachOutcome;
        try {
          outcome = await detachCustomDomain(cf(), {
            hostname: domain.hostname,
            cfId: domain.cfId,
            workerName,
          });
        } catch (error) {
          if (!isPermissionError(error)) throw error;
          throw new JobError(
            `Cloudflare refused to remove the custom domain ${domain.hostname} (${errorMessage(error)}). The token needs Workers Routes: Edit on its zone; add it to the token and retry the uninstall`,
          );
        }
        log.info(detachMessage(domain.hostname, outcome));
        await orm
          .update(resources)
          .set({ deleted_at: new Date(now()) })
          .where(eq(resources.id, domain.id));
        return {};
      });
    }

    const workerStep =
      started.worker === "live" ? `delete Worker ${workerName}` : `skip Worker ${workerName}`;
    await run(workerStep, async ({ log, cf, orm }) => {
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

    /** R2 pages this run deleted, and the objects on them. */
    let r2Pages = 0;
    let r2Deleted = 0;
    const r2PageLimit = steps.units.remote ? R2_MAX_PAGES_PER_RUN : R2_MAX_LOCAL_PAGES_PER_RUN;
    const r2PerPage = steps.units.remote ? R2_OBJECTS_PER_STEP : R2_OBJECTS_PER_LOCAL_STEP;
    for (const target of started.targets) {
      const label = RESOURCE_LABEL[target.kind];
      if (target.kind === "r2") {
        const bucket = target.cfId ?? target.name;
        // Deleted objects drop out of the listing, so every page lists from the
        // start again. A first key seen twice means a delete did not take.
        let previousFirst: string | null = null;
        for (let page = 1; ; page++) {
          if (r2Pages >= r2PageLimit) {
            steps.current = `empty ${label} ${target.name}`;
            throw new JobError(
              `one run deletes at most ${r2PageLimit * r2PerPage} R2 objects (${r2PageLimit} page(s) of ${r2PerPage}); this run deleted ${r2Deleted}, and ${target.name} ${page === 1 ? "is not emptied yet" : "still holds more"}. Retry the uninstall to continue`,
            );
          }
          r2Pages += 1;
          const emptied = await run(`empty ${label} ${target.name} page ${page}`, async ({ log }) =>
            settleUnit(
              await steps.units.api.emptyR2Page({
                accountId: steps.accountId(),
                bucket,
                name: target.name,
                perPage: r2PerPage,
                previousFirst,
              }),
              log,
            ),
          );
          r2Deleted += emptied.deleted;
          if (!emptied.more) break;
          previousFirst = emptied.first;
        }
      }

      await run(`delete ${label} ${target.name}`, async ({ log, cf, orm }) => {
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

    await run("finish", async ({ log, orm }) => {
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
