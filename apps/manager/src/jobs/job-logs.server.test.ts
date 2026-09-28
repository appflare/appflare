import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { job_logs, jobs } from "../db/schema";
import { readJobLogs } from "./job-logs.server";

const db = () => createDb(env.DB);

async function seed(): Promise<number[]> {
  for (const id of ["job1", "job2"]) {
    await db()
      .insert(jobs)
      .values({ id, kind: "install", status: "running", started_at: new Date(1) });
  }
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    for (const jobId of ["job1", "job2"]) {
      const [row] = await db()
        .insert(job_logs)
        .values({ job_id: jobId, ts: new Date(1000 + i), level: "info", message: `${jobId} ${i}` })
        .returning({ id: job_logs.id });
      if (jobId === "job1" && row !== undefined) ids.push(row.id);
    }
  }
  return ids;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("readJobLogs", () => {
  it("reads a job's whole log in order, and none of another job's", async () => {
    const ids = await seed();
    const lines = await readJobLogs(db(), "job1");
    expect(lines.map((l) => l.id)).toEqual(ids);
    expect(lines.every((l) => l.job_id === "job1")).toBe(true);
  });

  it("reads only the lines after the last one a page holds", async () => {
    const ids = await seed();
    const after = ids[2] ?? 0;
    const lines = await readJobLogs(db(), "job1", after);
    expect(lines.map((l) => l.id)).toEqual(ids.slice(3));
    expect(lines.map((l) => l.message)).toEqual(["job1 3", "job1 4"]);
    expect(await readJobLogs(db(), "job1", ids.at(-1))).toEqual([]);
    // From 0: everything, as a page that held no line yet asks.
    expect((await readJobLogs(db(), "job1", 0)).map((l) => l.id)).toEqual(ids);
  });
});
