import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { jobCreator } from "../jobs/create-job.server";
import { activeSelfUpdateJob } from "../jobs/self-update/guard";
import { SelfUpdateError, startSelfUpdateCore } from "../jobs/self-update/start.server";
import { requireRole, requireSession } from "../server/auth.server";
import { runningVersion } from "../server/build-version";
import {
  ManagerReleasesError,
  type ManagerUpdateView,
  managerUpdateView,
  readManagerLatest,
  refreshManagerReleases,
} from "./manager-releases.server";

/** Settings, Updates, "Appflare version": the release feed and the self-update. */

export interface ManagerUpdateState extends ManagerUpdateView {
  /** The self-update queued or running, if any. */
  activeJobId: string | null;
}

async function state(): Promise<ManagerUpdateState> {
  const [latest, activeJobId] = await Promise.all([
    readManagerLatest(env.KV),
    activeSelfUpdateJob(env.DB, env.JOBS),
  ]);
  return { ...managerUpdateView(runningVersion(env), latest), activeJobId };
}

/** Any signed-in user: the running version, the newest release, and whether it is newer. */
export const getManagerUpdate = createServerFn({ method: "GET" }).handler(
  async (): Promise<ManagerUpdateState> => {
    await requireSession();
    return state();
  },
);

/** Admin only: checks the release feed now instead of waiting for the cron. */
export const checkManagerUpdates = createServerFn({ method: "POST" }).handler(
  async (): Promise<ManagerUpdateState> => {
    await requireRole("admin");
    try {
      await refreshManagerReleases(env);
    } catch (error) {
      if (error instanceof ManagerReleasesError) throw new Error(error.message);
      throw error;
    }
    return state();
  },
);

/**
 * Admin only: starts the self-update to the newest release, which must be
 * the version the admin saw. Returns the job id for `/jobs/$jobId`.
 */
export const startSelfUpdate = createServerFn({ method: "POST" })
  .validator(z.object({ version: z.string().min(1).max(64) }))
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    await requireRole("admin");
    try {
      return await startSelfUpdateCore(
        {
          db: env.DB,
          latest: await readManagerLatest(env.KV),
          currentVersion: runningVersion(env),
          hasToken: typeof env.CF_API_TOKEN === "string" && env.CF_API_TOKEN.length > 0,
          workflows: env.JOBS,
          createJob: jobCreator(env.JOBS),
        },
        data,
      );
    } catch (error) {
      if (error instanceof SelfUpdateError) throw new Error(error.message);
      throw error;
    }
  });
