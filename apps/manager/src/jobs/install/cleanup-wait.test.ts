import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { fakeStep } from "../../test/fake-step";
import { createJobSteps } from "../steps";
import { awaitCleanupPhase, CLEANUP_WAIT } from "./cleanup-wait";

/** The wait for a failed install's removal, against the local D1. */

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at)
     VALUES ('old', 'cut', 'cut', '1.0.0', 'z', 'uninstalling', 1, 1),
            ('new', 'cut', 'cut', '1.0.0', 'z', 'installing', 1, 1)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO jobs (id, install_id, kind, status) VALUES
       ('removal', 'old', 'uninstall', 'running'), ('install', 'new', 'install', 'running')`,
  ).run();
});

const removalLine = (message: string) =>
  env.DB.prepare(
    "INSERT INTO job_logs (job_id, ts, level, message) VALUES ('removal', 1, 'info', ?1)",
  )
    .bind(message)
    .run();

const installLog = async () =>
  (
    await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = 'install' ORDER BY id").all<{
      message: string;
    }>()
  ).results.map((r) => r.message);

function setup(onSleep: (n: number) => Promise<void>) {
  let sleeps = 0;
  const pending: Promise<void>[] = [];
  const step = fakeStep({
    onSleep: () => {
      sleeps += 1;
      pending.push(onSleep(sleeps));
    },
  });
  // The fake sleep is synchronous: each poll waits for the change the sleep made.
  const waiting = {
    ...step,
    do: step.do.bind(step),
    async sleep(name: string, duration: string | number) {
      await step.sleep(name, duration);
      await Promise.all(pending);
    },
  };
  const steps = createJobSteps(
    { params: { kind: "install", jobId: "install" }, step: waiting, env: { DB: env.DB }, deps: {} },
    "install",
  );
  return { step, waiting, steps };
}

describe("awaitCleanupPhase", () => {
  it("backs off from 5 seconds, copies the removal's lines, and writes the log only when there are any", async () => {
    const { step, waiting, steps } = setup(async (n) => {
      if (n === 2) await removalLine('Deleted Worker "cut".');
      if (n === 3) {
        await removalLine('Uninstalled "cut".');
        await env.DB.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = 'removal'").run();
      }
    });
    await awaitCleanupPhase(steps, waiting, "removal");
    expect(step.sleepDurations).toEqual(["5 seconds", "10 seconds", "20 seconds"]);
    expect(step.names).toEqual([
      "wait for the failed install's removal (1)",
      "wait for the failed install's removal (2)",
      "wait for the failed install's removal (3)",
      "wait for the failed install's removal (4)",
    ]);
    // Polls 1 and 2 saw no lines and wrote nothing; each line is copied once.
    expect(await installLog()).toEqual([
      'Removing the failed install: Deleted Worker "cut".',
      'Removing the failed install: Uninstalled "cut".',
    ]);
  });

  it("moves to 5-minute polls after about a minute, and gives up after about 20", async () => {
    const { step, waiting, steps } = setup(async () => {});
    await expect(awaitCleanupPhase(steps, waiting, "removal")).rejects.toThrow(
      "still being removed after about 20 minutes",
    );
    expect(step.sleepDurations).toEqual(CLEANUP_WAIT.sleeps.map((s) => `${s} seconds`));
    expect(await installLog()).toEqual([]);
  });

  it("says where to finish a removal that failed, and what to do then", async () => {
    await env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error = 'delete KV namespace cut-cut-kv: refused' WHERE id = 'removal'",
    ).run();
    const { waiting, steps } = setup(async () => {});
    await expect(awaitCleanupPhase(steps, waiting, "removal")).rejects.toThrow(
      "delete KV namespace cut-cut-kv: refused. Nothing of this install was created. Open the app page of the earlier install, finish uninstalling it from its danger zone, then use Install again on this install's page",
    );
  });
});
