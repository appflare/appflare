import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppLookup, ListedApp } from "../catalog/merged.server";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { readFailedJobs, readUpdateNeeds, WAITING_FOR_INPUT } from "./attention.server";

/** The failed jobs and waiting updates Home reads, against the local D1. */

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
});

async function addJob(
  id: string,
  kind: string,
  status: string,
  finishedAt: number | null,
  input = "{}",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, install_id, kind, status, input_json, started_at, finished_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, INSTALL_ID, kind, status, input, finishedAt, finishedAt)
    .run();
}

describe("readFailedJobs", () => {
  it("returns an app's latest finished job when it failed", async () => {
    await addJob("a", "install", "succeeded", 1_000);
    await addJob("b", "update", "failed", 2_000, '{"version":"1.1.0"}');
    expect(await readFailedJobs(env.DB)).toEqual([
      {
        id: "b",
        installId: INSTALL_ID,
        kind: "update",
        restore: false,
        deleteRetained: false,
        accessChange: false,
        version: "1.1.0",
        finishedAt: new Date(2_000).toISOString(),
      },
    ]);
  });

  it("forgets a failure once a later job of the app succeeds", async () => {
    await addJob("a", "update", "failed", 1_000, '{"version":"1.1.0"}');
    await addJob("b", "reconfigure", "succeeded", 2_000);
    expect(await readFailedJobs(env.DB)).toEqual([]);
  });

  it("ignores jobs still running, builds for review, and uninstalled apps", async () => {
    await addJob("a", "update", "failed", 1_000);
    await addJob("b", "update", "running", null);
    expect((await readFailedJobs(env.DB)).map((j) => j.id)).toEqual(["a"]);

    await addJob("c", "source_build", "failed", 3_000);
    expect((await readFailedJobs(env.DB)).map((j) => j.id)).toEqual(["a"]);

    await env.DB.prepare("UPDATE installs SET status = 'uninstalled' WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    expect(await readFailedJobs(env.DB)).toEqual([]);
  });

  it("tells a database restore from a rollback", async () => {
    await addJob("a", "rollback", "failed", 1_000, '{"snapshotId":"s","restore":true}');
    expect((await readFailedJobs(env.DB))[0]).toMatchObject({ kind: "rollback", restore: true });
  });
});

function listing(version: string, tier = "artifact"): AppLookup {
  // Only the version and the tier are read.
  return new Map([["cut", { key: "cut", app: { version, tier } } as unknown as ListedApp]]);
}

describe("readUpdateNeeds", () => {
  it("leaves out an update that Update can start", async () => {
    expect(await readUpdateNeeds(env.DB, null, listing("1.1.0"))).toEqual(new Map());
  });

  it("says why an update waits for the admin", async () => {
    expect(
      (await readUpdateNeeds(env.DB, null, listing("1.1.0", "sandbox"))).get(INSTALL_ID),
    ).toMatch(/approve each time/);

    await addJob("a", "update", "failed", 1_000, '{"version":"1.1.0"}');
    await addJob("b", "reconfigure", "succeeded", 2_000);
    expect((await readUpdateNeeds(env.DB, null, listing("1.1.0"))).get(INSTALL_ID)).toBe(
      "An update to this version failed before.",
    );
  });

  it("says so when automatic updates found the update needs something", async () => {
    await env.DB.prepare("UPDATE installs SET auto_update_waiting = '1.1.0' WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    expect((await readUpdateNeeds(env.DB, null, listing("1.1.0"))).get(INSTALL_ID)).toBe(
      WAITING_FOR_INPUT,
    );
    // A newer version than the one it waited on may start again.
    expect(await readUpdateNeeds(env.DB, null, listing("1.2.0"))).toEqual(new Map());
  });
});
