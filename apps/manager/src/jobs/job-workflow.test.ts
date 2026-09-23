import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { manifestCacheKey } from "../catalog/app-manifest.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { startInstallCore } from "../installs/start-install.server";
import { buildArtifactFixture } from "../test/artifact-fixture";

/**
 * The install job inside the real Workflows engine (miniflare): `JobWorkflow`
 * dispatches to `runInstall`, `step.do(name, config, callback)` works through
 * the RPC stub, and a `NonRetryableError` thrown inside a step is caught by the
 * job so its "mark install failed" step still runs (developers.cloudflare.com/
 * workflows/build/sleeping-and-retrying, "Catch Workflow errors"; miniflare logs
 * "Aborting engine" for the step but runs the catch block). The artifact
 * step is mocked (no network in tests); the test env has no `CF_API_TOKEN`, so
 * the job must stop at preflight without calling Cloudflare. The manifest step is
 * mocked; the job reads the manifest from the KV cache by digest.
 */

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: "acc0000000000000000000000000000a",
  });
});

describe("JobWorkflow install", () => {
  it("runs in the engine and records a preflight failure on the job and install", async () => {
    expect(env.CF_API_TOKEN).toBeUndefined();
    const fixture = await buildArtifactFixture();
    const jobId = "01JOBWORKFLOWENGINE0000000";
    // The job re-reads the verified manifest from the catalog cache by digest.
    await env.KV.put(
      manifestCacheKey(fixture.digest),
      new TextDecoder().decode(fixture.manifestBytes),
    );
    await using instance = await introspectWorkflowInstance(env.JOBS, jobId);
    await instance.modify(async (m) => {
      await m.mockStepResult(
        { name: "verify artifact manifest" },
        { keyId: "test-key", subrequests: 0 },
      );
    });
    let n = 0;
    const ids = await startInstallCore(
      {
        db: env.DB,
        loadApp: async () => ({ app: fixture.index, manifest: fixture.manifest }),
        createJob: (id, params) => env.JOBS.create({ id, params }),
        newId: () => (++n === 1 ? "01INSTALLENGINE00000000000" : jobId),
      },
      {
        slug: "cut",
        workerName: "cut",
        secrets: { ADMIN_PASSWORD: "x".repeat(32) },
        vars: {},
        paidConfirmed: false,
        requirementsConfirmed: false,
      },
    );
    expect(ids.jobId).toBe(jobId);

    await instance.waitForStatus("errored");
    // The engine reports its own fatal error for the instance; what users see is
    // the job row, written by the job's "mark install failed" step.
    expect((await instance.getError()).message).toMatch(/NonRetryableError/);
    const job = await env.DB.prepare("SELECT status, error, started_at FROM jobs WHERE id = ?1")
      .bind(jobId)
      .first<{ status: string; error: string; started_at: number | null }>();
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe(
      "preflight checks: the Cloudflare API token is not configured; finish setup first",
    );
    expect(job?.started_at).not.toBeNull();
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = ?1")
      .bind(ids.installId)
      .first<{ status: string }>();
    expect(install?.status).toBe("failed");
    const logs = await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<{ message: string }>();
    expect(logs.results.map((l) => l.message)).toEqual([
      'Installing cut 1.0.0 as Worker "cut".',
      "preflight checks failed: the Cloudflare API token is not configured; finish setup first",
      'Install failed at "preflight checks". Resources created so far stay recorded.',
    ]);
  });
});
