import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING } from "../db/settings";
import { type ArtifactFixtureOptions, buildArtifactFixture } from "../test/artifact-fixture";
import { ACC, type FakeAccount, fakeAccount, TOKEN } from "../test/fake-account";
import { type SeedResource, seedInstall } from "../test/seed-install";
import {
  repairWorkflows,
  WORKFLOW_REPAIRS_PER_RUN,
  workflowRepairLog,
  workflowRepairNeeded,
} from "./workflow-repair.server";

/**
 * The cron's repair of Workflows that managers up to 0.2.0 recorded but
 * never created, against the fake Cloudflare API (where, as on Cloudflare,
 * a Workflow exists only once `PUT /workflows/{name}` made it).
 */

const NOW = new Date("2026-10-04T12:00:00.000Z");
const jobs = { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "Jobs" };
const prefix: SeedResource = { kind: "workflow", binding: "JOBS", name: "cut-jobs" };

async function seed(
  options: ArtifactFixtureOptions,
  resources: SeedResource[],
  status = "installed",
): Promise<void> {
  const fixture = await buildArtifactFixture(options);
  await seedInstall({
    status,
    manifestJson: JSON.stringify(fixture.manifest),
    resources: [{ kind: "worker", name: "cut", cfId: "cut" }, ...resources],
  });
}

async function repair(world: Partial<FakeAccount> = {}, now = NOW) {
  const fake = fakeAccount(null, world);
  const api = createClient({ accountId: ACC, token: TOKEN, fetch: fake.fetch });
  const report = await repairWorkflows({ db: env.DB, api: async () => api, now: () => now });
  return { fake, report };
}

const rows = async () =>
  (
    await env.DB.prepare(
      "SELECT binding, name, cf_id, deleted_at IS NULL AS live FROM resources WHERE kind = 'workflow' ORDER BY rowid",
    ).all()
  ).results;

/** Starts an instance of `name` the way the app's binding would. */
const startInstance = (fake: ReturnType<typeof fakeAccount>, name: string) =>
  fake.fetch(`https://api.cloudflare.com/client/v4/accounts/${ACC}/workflows/${name}/instances`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("repair of installed apps' Workflows", () => {
  it("creates a Workflow an earlier manager recorded but never created", async () => {
    await seed({ bindings: [jobs] }, [prefix]);
    expect(await workflowRepairNeeded(env.DB, NOW)).toBe(true);
    const fake = fakeAccount(null);
    // As the app saw it: no Workflow, so starting one fails.
    expect((await startInstance(fake, "cut-jobs")).status).toBe(404);

    const api = createClient({ accountId: ACC, token: TOKEN, fetch: fake.fetch });
    const report = await repairWorkflows({ db: env.DB, api: async () => api, now: () => NOW });
    expect(report).toEqual({
      checked: 1,
      created: ["cut-jobs"],
      found: [],
      unused: [],
      failed: [],
    });
    expect(fake.state.calls).toEqual([
      "POST /workflows/cut-jobs/instances",
      "GET /workflows/cut-jobs",
      "PUT /workflows/cut-jobs",
    ]);
    expect(fake.state.workflowDefs).toEqual({
      "cut-jobs": { script_name: "cut", class_name: "Jobs" },
    });
    expect((await startInstance(fake, "cut-jobs")).status).toBe(200);
    expect(await rows()).toEqual([
      { binding: "JOBS", name: "cut-jobs", cf_id: "wf-cut-jobs", live: 1 },
    ]);
    expect(workflowRepairLog(report)).toBe("workflows: 1 checked, created cut-jobs");
    // Nothing left: the next runs make no Cloudflare call, today or later.
    expect(await workflowRepairNeeded(env.DB, NOW)).toBe(false);
    expect(await workflowRepairNeeded(env.DB, new Date("2026-10-05T12:00:00.000Z"))).toBe(false);
  });

  it("creates a cross-Worker Workflow for the Worker that defines it, as OpenSEO's", async () => {
    const siteAudit = {
      type: "workflow",
      name: "SITE_AUDIT_WORKFLOW",
      workflow_name: "site-audit-workflow",
      class_name: "SiteAuditWorkflow",
    };
    await seed(
      {
        bindings: [
          { ...siteAudit, script_name: "{{workerName:audit}}" },
          {
            type: "workflow",
            name: "RANK_CHECK_WORKFLOW",
            workflow_name: "rank-check-workflow",
            class_name: "RankCheckWorkflow",
          },
        ],
        otherWorkers: [{ name: "audit", bindings: [siteAudit] }],
      },
      [
        { kind: "worker", name: "cut-audit", cfId: "cut-audit" },
        {
          kind: "workflow",
          binding: "SITE_AUDIT_WORKFLOW",
          name: "cut-site-audit-workflow",
        },
        {
          kind: "workflow",
          binding: "RANK_CHECK_WORKFLOW",
          name: "cut-rank-check-workflow",
        },
      ],
    );
    const { fake, report } = await repair();
    expect(report.created).toEqual(["cut-site-audit-workflow", "cut-rank-check-workflow"]);
    expect(fake.state.workflowDefs).toEqual({
      "cut-site-audit-workflow": { script_name: "cut-audit", class_name: "SiteAuditWorkflow" },
      "cut-rank-check-workflow": { script_name: "cut", class_name: "RankCheckWorkflow" },
    });
  });

  it("records the id of a Workflow that exists, without changing it", async () => {
    await seed({ bindings: [jobs] }, [prefix]);
    const { fake, report } = await repair({
      workflows: ["cut-jobs"],
      workflowDefs: { "cut-jobs": { script_name: "cut", class_name: "Jobs" } },
    });
    expect(report.found).toEqual(["cut-jobs"]);
    expect(fake.state.calls).toEqual(["GET /workflows/cut-jobs"]);
    expect(await rows()).toEqual([
      { binding: "JOBS", name: "cut-jobs", cf_id: "wf-cut-jobs", live: 1 },
    ]);
  });

  it("leaves a Workflow of another Worker alone", async () => {
    await seed({ bindings: [jobs] }, [prefix]);
    const { fake, report } = await repair({ workflows: ["cut-jobs"] });
    expect(report.failed).toEqual([
      { name: "cut-jobs", reason: 'it runs the Worker "someone", which is not this app\'s' },
    ]);
    expect(fake.state.calls).not.toContain("PUT /workflows/cut-jobs");
    expect(await rows()).toEqual([{ binding: "JOBS", name: "cut-jobs", cf_id: null, live: 1 }]);
  });

  it("finds the Workflow of a row an update kept under a renamed binding", async () => {
    // The version binds the Workflow "jobs" as TASKS; the row still says JOBS.
    await seed({ bindings: [{ ...jobs, name: "TASKS", class_name: "Tasks" }] }, [prefix]);
    const { fake, report } = await repair();
    expect(report.created).toEqual(["cut-jobs"]);
    expect(fake.state.workflowDefs).toEqual({
      "cut-jobs": { script_name: "cut", class_name: "Tasks" },
    });
    expect(await rows()).toEqual([
      { binding: "JOBS", name: "cut-jobs", cf_id: "wf-cut-jobs", live: 1 },
    ]);
  });

  it("skips an app a job is changing, and one an uninstall starts mid-run", async () => {
    await seed({ bindings: [jobs] }, [prefix]);
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('u1', 'i1', 'update', 'queued')",
    ).run();
    expect(await workflowRepairNeeded(env.DB, NOW)).toBe(false);
    expect((await repair()).fake.state.calls).toEqual([]);

    await env.DB.prepare("DELETE FROM jobs").run();
    const fake = fakeAccount(null);
    // The uninstall starts while the repair looks the Workflow up.
    const fetch = async (input: string, init?: RequestInit) => {
      if (input.endsWith("/workflows/cut-jobs") && (init?.method ?? "GET") === "GET") {
        await env.DB.prepare("UPDATE installs SET status = 'uninstalling'").run();
      }
      return fake.fetch(input, init);
    };
    const api = createClient({ accountId: ACC, token: TOKEN, fetch });
    const report = await repairWorkflows({ db: env.DB, api: async () => api, now: () => NOW });
    expect(report.failed).toEqual([{ name: "cut-jobs", reason: "a job is changing the app" }]);
    expect(fake.state.calls).toEqual(["GET /workflows/cut-jobs"]);
  });

  it("marks gone a missing Workflow the installed version no longer defines", async () => {
    await seed({ bindings: [] }, [prefix]);
    const { fake, report } = await repair();
    expect(report.unused).toEqual(["cut-jobs"]);
    expect(fake.state.calls).toEqual(["GET /workflows/cut-jobs"]);
    expect(await rows()).toEqual([{ binding: "JOBS", name: "cut-jobs", cf_id: null, live: 0 }]);
  });

  it("looks only at installed apps and Workflows not known to exist", async () => {
    await seed({ bindings: [jobs] }, [prefix], "updating");
    expect(await workflowRepairNeeded(env.DB, NOW)).toBe(false);
    const { fake, report } = await repair();
    expect(report.checked).toBe(0);
    expect(fake.state.calls).toEqual([]);
  });

  it("never throws for a failed call, and tries again the next day", async () => {
    await seed({ bindings: [jobs] }, [prefix]);
    const { report } = await repair({ failOnce: new Map([["GET /workflows/cut-jobs", 500]]) });
    expect(report.failed.map((f) => f.name)).toEqual(["cut-jobs"]);
    expect(workflowRepairLog(report)).toContain("failed cut-jobs (");
    expect(await workflowRepairNeeded(env.DB, NOW)).toBe(false);
    const tomorrow = new Date("2026-10-05T00:30:00.000Z");
    expect(await workflowRepairNeeded(env.DB, tomorrow)).toBe(true);
    const again = await repair({}, tomorrow);
    expect(again.report.created).toEqual(["cut-jobs"]);
    const done = await readSettings(createDb(env.DB), [SETTING.workflowRepairDay]);
    expect(done.workflow_repair_day).toBe("2026-10-05");
  });

  it(`goes on in the next run after ${WORKFLOW_REPAIRS_PER_RUN} Workflows`, async () => {
    const many = Array.from({ length: WORKFLOW_REPAIRS_PER_RUN + 2 }, (_, i) => ({
      type: "workflow",
      name: `FLOW_${i}`,
      workflow_name: `flow-${i}`,
      class_name: `Flow${i}`,
    }));
    await seed(
      { bindings: many },
      many.map((b) => ({ kind: "workflow", binding: b.name, name: `cut-flow-${b.name.slice(5)}` })),
    );
    const first = await repair();
    expect(first.report.created).toHaveLength(WORKFLOW_REPAIRS_PER_RUN);
    expect(await workflowRepairNeeded(env.DB, NOW)).toBe(true);
    const second = await repair();
    expect(second.report.created).toEqual(["cut-flow-10", "cut-flow-11"]);
    expect(await workflowRepairNeeded(env.DB, NOW)).toBe(false);
  });
});
