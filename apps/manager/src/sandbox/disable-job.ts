import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError } from "@appflare/cf-api";
import { SANDBOX_BUCKET_NAME, SANDBOX_CONTAINERS, SANDBOX_WORKER_NAME } from "@appflare/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db/client";
import { github_tokens, jobs } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { lookupSubdomainPhase } from "../jobs/install/phases";
import type { JobContext } from "../jobs/run-job";
import { StepLog } from "../jobs/step-log";
import { createJobSteps, errorMessage, isNotFound, JobError } from "../jobs/steps";
import { R2_MAX_PAGES_PER_RUN, R2_OBJECTS_PER_STEP } from "../jobs/uninstall";
import { settleUnit } from "../jobs/units/result";
import { runningVersion } from "../server/build-version";
import { installsNeedingSandbox, sandboxInUseMessage } from "./blockers";
import { isSandboxWorker } from "./deploy-plan";
import { requireSelf } from "./enable-job";
import { NO_CONTAINERS_PERMISSION_REASON } from "./preflight";

/**
 * The `sandbox_disable` job: removes sandbox builds from the account, leaving
 * it as it was before they were enabled. Refused while any install still
 * needs the sandbox Worker. Each removal first checks the thing is still
 * there, so a retried or repeated run converges.
 *
 * 1. Delete the sandbox Worker with `?force=true`: Cloudflare refuses a
 *    plain delete (code 10142) while any version of another Worker binds it,
 *    and the manager's serving version still does. Its Durable Object
 *    namespaces go with it, and so do its secrets: the records of the
 *    GitHub access tokens it held are deleted next.
 * 2. Delete the container applications, which outlive the Worker.
 * 3. Empty the build bucket, a page per job unit, and delete it.
 * 4. Disconnect the manager: a new version of its Worker without `SANDBOX`,
 *    checked on its preview, then deployed; the job is recorded as done in
 *    the same step.
 *
 * The disconnect is last because it deploys the manager's own Worker, which
 * this Workflow instance runs on: a step run after such a deploy was seen to
 * hang for about five minutes and fail with an internal Workflows error
 * before its retry went through. With nothing after it, a cut-off step just
 * runs again, finds no binding, and records the job once more. Until then
 * the manager keeps a binding to a Worker that is gone, and a call through
 * it fails much as it would with no binding; disabling is refused while any
 * install needs the sandbox Worker, so no app depends on it meanwhile.
 */

export const sandboxDisableJobParams = z.object({
  kind: z.literal("sandbox_disable"),
  jobId: z.string().min(1),
  /** The running Appflare version (`runningVersion`) when the job started. */
  managerVersion: z.string().min(1),
});
export type SandboxDisableJobParams = z.infer<typeof sandboxDisableJobParams>;

export async function runSandboxDisable(ctx: JobContext): Promise<void> {
  const parsed = sandboxDisableJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid sandbox job payload");
  const params = parsed.data;
  const { step, env, deps } = ctx;
  const now = deps.now ?? Date.now;
  const steps = createJobSteps(ctx, params.jobId);
  const { run } = steps;

  try {
    const started = await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      const settings = await readSettings(orm, [SETTING.accountId, SETTING.workerName]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!settings.worker_name) throw new JobError("Appflare does not know its own Worker yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      requireSelf(steps.units.remote);
      const blocking = await installsNeedingSandbox(orm);
      if (blocking.length > 0) throw new JobError(sandboxInUseMessage(blocking));
      log.info(
        `Disabling sandbox builds: the sandbox Worker "${SANDBOX_WORKER_NAME}", its container applications and the bucket ${SANDBOX_BUCKET_NAME} go.`,
      );
      return { accountId: settings.account_id, workerName: settings.worker_name };
    });
    steps.setAccountId(started.accountId);

    // 1. The Worker, while the manager still binds it (hence `force`).
    await run(`delete Worker ${SANDBOX_WORKER_NAME}`, async ({ log, cf }) => {
      const api = cf();
      if (!(await api.workers.listScripts()).some((s) => s.id === SANDBOX_WORKER_NAME)) {
        log.info(`There is no Worker "${SANDBOX_WORKER_NAME}"; nothing to delete there.`);
        return {};
      }
      if (!isSandboxWorker(await api.workers.getBindings(SANDBOX_WORKER_NAME))) {
        throw new JobError(
          `the Worker "${SANDBOX_WORKER_NAME}" is not an Appflare sandbox Worker, so it is left alone; nothing else was deleted`,
        );
      }
      try {
        await api.workers.deleteScript(SANDBOX_WORKER_NAME, { force: true });
        log.info(`Deleted the Worker "${SANDBOX_WORKER_NAME}" and its Durable Objects.`);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        log.info(`The Worker "${SANDBOX_WORKER_NAME}" was already gone.`);
      }
      return {};
    });

    // The GitHub access tokens were secrets of that Worker; their records go too.
    await run("forget GitHub access tokens", async ({ log, orm }) => {
      const rows = await orm.delete(github_tokens).returning({ id: github_tokens.id });
      if (rows.length > 0) {
        log.info(
          `Removed ${rows.length} GitHub access token(s): they were kept on the sandbox Worker, which is gone. Add them again after enabling sandbox builds.`,
        );
      }
      return {};
    });

    // 2. The container applications.
    for (const container of SANDBOX_CONTAINERS) {
      await run(`delete container application ${container.name}`, async ({ log, cf }) => {
        const api = cf();
        let found: Awaited<ReturnType<typeof api.containers.listApplications>>;
        try {
          found = (await api.containers.listApplications({ name: container.name })).filter(
            (a) => a.name === container.name,
          );
        } catch (error) {
          if (error instanceof CloudflareApiError && error.status === 403) {
            throw new JobError(NO_CONTAINERS_PERMISSION_REASON);
          }
          if (error instanceof CloudflareApiError && error.status === 401) {
            // Containers refused to the account (no longer on Workers Paid).
            log.warn(
              `Cloudflare refuses Containers on this account now, so ${container.name} could not be checked. If it is still listed under Workers > Containers in the dashboard, delete it there.`,
            );
            return {};
          }
          throw error;
        }
        if (found.length === 0) {
          log.info(`There is no container application ${container.name}.`);
          return {};
        }
        for (const app of found) {
          try {
            await api.containers.deleteApplication(app.id);
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
        }
        log.info(`Deleted the container application ${container.name}.`);
        return {};
      });
    }

    // 3. The bucket: emptied a page per unit, then deleted.
    const pageLimit = R2_MAX_PAGES_PER_RUN;
    const perPage = R2_OBJECTS_PER_STEP;
    let previousFirst: string | null = null;
    let deleted = 0;
    for (let page = 1; ; page++) {
      if (page > pageLimit) {
        steps.current = `empty bucket ${SANDBOX_BUCKET_NAME}`;
        throw new JobError(
          `one run deletes at most ${pageLimit * perPage} objects (${pageLimit} page(s) of ${perPage}); this run deleted ${deleted} and the bucket holds more. Disable sandbox builds again to continue`,
        );
      }
      const emptied = await run(
        `empty bucket ${SANDBOX_BUCKET_NAME} page ${page}`,
        async ({ log }) =>
          settleUnit(
            await steps.units.api.emptyR2Page({
              accountId: steps.accountId(),
              bucket: SANDBOX_BUCKET_NAME,
              name: SANDBOX_BUCKET_NAME,
              perPage,
              previousFirst,
            }),
            log,
          ),
      );
      deleted += emptied.deleted;
      if (!emptied.more) break;
      previousFirst = emptied.first;
    }
    await run(`delete bucket ${SANDBOX_BUCKET_NAME}`, async ({ log, cf }) => {
      try {
        await cf().r2.deleteBucket(SANDBOX_BUCKET_NAME);
        log.info(
          `Deleted the R2 bucket ${SANDBOX_BUCKET_NAME} (${deleted} object(s) removed first).`,
        );
      } catch (error) {
        if (isNotFound(error)) {
          log.info(`There is no R2 bucket ${SANDBOX_BUCKET_NAME}.`);
          return {};
        }
        if (error instanceof CloudflareApiError && error.status === 409) {
          // The REST API cannot list or abort incomplete multipart uploads.
          throw new JobError(
            `Cloudflare refused to delete the bucket (${error.message}). A bucket with incomplete multipart uploads cannot be deleted, and the Cloudflare API cannot list or abort them; abort them with the S3 API or a lifecycle rule, or delete the bucket in the dashboard`,
          );
        }
        throw error;
      }
      return {};
    });

    // 4. The manager's own binding, last: see the module comment.
    const subdomain = await lookupSubdomainPhase(steps);
    await run("disconnect Appflare from the sandbox Worker", async ({ log, orm }) => {
      settleUnit(
        await steps.units.api.setSandboxBinding({
          accountId: steps.accountId(),
          workerName: started.workerName,
          subdomain,
          currentVersion: runningVersion(env) ?? params.managerVersion,
          connect: false,
        }),
        log,
      );
      await orm
        .update(jobs)
        .set({ status: "succeeded", finished_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      log.info("Sandbox builds are off, and nothing of them is left in the account.");
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    await step.do("mark sandbox job failed", async () => {
      await createDb(env.DB)
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      const log = new StepLog(now);
      log.error(
        `Stopped at "${steps.current}". What was removed stays removed; disable sandbox builds again to remove the rest.`,
      );
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
