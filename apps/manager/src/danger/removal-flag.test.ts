import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runScheduledUpdates, scheduledUpdatesLog } from "../auto-update/cron.server";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { NO_ACTIVE_SELF_UPDATE_SQL, refuseDuringSelfUpdate } from "../jobs/self-update/guard";
import { startSelfUpdateCore } from "../jobs/self-update/start.server";
import {
  clearRemovalStarted,
  markRemovalStarted,
  REMOVAL_IN_PROGRESS_MESSAGE,
  REMOVAL_STALE_MS,
  removalInProgress,
} from "./removal-flag";

/** The mark a running removal leaves, and how every job start honours it. */

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

/** Whether a job start's conditional insert would claim now. */
async function claimAllowed(): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT CASE WHEN ${NO_ACTIVE_SELF_UPDATE_SQL} THEN 1 ELSE 0 END AS ok`,
  ).first<{ ok: number }>();
  return row?.ok === 1;
}

describe("removal in progress", () => {
  it("refuses job starts while set, and allows them again once cleared", async () => {
    expect(await claimAllowed()).toBe(true);
    await markRemovalStarted(env.DB, new Date());
    expect(await removalInProgress(env.DB)).not.toBeNull();
    expect(await claimAllowed()).toBe(false);
    await expect(refuseDuringSelfUpdate(env.DB, undefined, (m) => new Error(m))).rejects.toThrow(
      REMOVAL_IN_PROGRESS_MESSAGE,
    );

    await clearRemovalStarted(env.DB);
    expect(await removalInProgress(env.DB)).toBeNull();
    expect(await claimAllowed()).toBe(true);
    await expect(
      refuseDuringSelfUpdate(env.DB, undefined, (m) => new Error(m)),
    ).resolves.toBeUndefined();
  });

  it("refuses Appflare's own update", async () => {
    await markRemovalStarted(env.DB, new Date());
    await expect(
      startSelfUpdateCore(
        {
          db: env.DB,
          latest: null,
          currentVersion: "0.1.0",
          hasToken: true,
          workflows: { get: () => Promise.reject(new Error("not used")) },
          createJob: () => Promise.reject(new Error("no job may start")),
        },
        { version: "0.2.0" },
      ),
    ).rejects.toThrow(REMOVAL_IN_PROGRESS_MESSAGE);
  });

  it("keeps the cron from starting automatic updates", async () => {
    await markRemovalStarted(env.DB, new Date());
    const outcome = await runScheduledUpdates({
      DB: env.DB,
      KV: env.KV,
      JOBS: {
        get: () => Promise.reject(new Error("not used")),
        create: () => Promise.reject(new Error("no job may start")),
      },
      APPFLARE_VERSION: "0.1.0",
      CF_API_TOKEN: "token",
    });
    expect(outcome).toEqual({ selfUpdate: null, apps: [], idle: "removing" });
    expect(scheduledUpdatesLog(outcome)).toEqual([
      "automatic updates: skipped, Appflare is being removed from this account",
    ]);
  });

  it("ignores a mark left by a removal that died long ago", async () => {
    await markRemovalStarted(env.DB, new Date(Date.now() - REMOVAL_STALE_MS - 60_000));
    expect(await removalInProgress(env.DB)).toBeNull();
    expect(await claimAllowed()).toBe(true);
  });
});
