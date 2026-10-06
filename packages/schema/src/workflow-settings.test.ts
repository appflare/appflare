import { describe, expect, it } from "vitest";
import { artifactManifestSchema, strictArtifactManifestSchema } from "./artifact";
import {
  scheduledWorkflowPlanProblem,
  workflowSettingsProblems,
  workflowSettingsSchema,
} from "./workflow-settings";

const sha256 = "a".repeat(64);
const gitSha = "b".repeat(40);

/** A one-Worker artifact whose Worker defines the Workflow `jobs` (binding JOBS). */
function artifact(
  worker: Record<string, unknown> = {},
  plan: "free" | "paid" = "free",
): Record<string, unknown> {
  return {
    format: 1,
    app: "relay",
    version: "1.0.0",
    builtAt: "2026-10-05T12:00:00Z",
    builder: "@appflare/pack@0.3.1",
    keyId: "catalog-2026-09",
    worker: {
      name: "relay",
      wranglerConfig: { declared: "wrangler.jsonc", effective: "wrangler.jsonc" },
      mainModule: "index.js",
      compatibilityDate: "2026-09-01",
      compatibilityFlags: [],
      modules: [
        { name: "index.js", type: "esm", path: "worker/index.js", size: 1, sha256, offset: 0 },
      ],
      bindings: [{ type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "Jobs" }],
      migrations: [],
      crons: [],
      observability: null,
      placement: null,
      limits: null,
      ...worker,
    },
    assets: { config: {}, binding: null, files: [] },
    d1: {},
    catalog: {
      slug: "relay",
      name: "Relay",
      summary: "Relays jobs on a schedule.",
      tagline: "Jobs that run themselves",
      repo: "example/relay",
      license: "MIT",
      categories: ["utilities"],
      maintainers: ["example"],
      source: { ref: "v1.0.0", sha: gitSha },
      install: {
        tier: "artifact",
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        workerName: "relay",
      },
      plan,
      requires: [],
      secrets: [],
      vars: [],
      postInstall: [],
      tokenPermissions: [],
    },
  };
}

const settings = {
  limits: { steps: 500 },
  concurrency: { limit: 3 },
  default_retention: { success_retention: "1 day", error_retention: 3_600_000 },
};

describe("worker.workflowSettings", () => {
  it("is optional, and kept as recorded for a Workflow the Worker defines", () => {
    expect(artifactManifestSchema.parse(artifact()).worker.workflowSettings).toBeUndefined();
    const parsed = artifactManifestSchema.parse(artifact({ workflowSettings: { JOBS: settings } }));
    expect(parsed.worker.workflowSettings).toEqual({ JOBS: settings });
    expect(
      strictArtifactManifestSchema.safeParse(artifact({ workflowSettings: { JOBS: settings } }))
        .success,
    ).toBe(true);
  });

  it("refuses, in its strict form, a setting the packer must not write", () => {
    const result = strictArtifactManifestSchema.safeParse(
      artifact({ workflowSettings: { JOBS: { limits: { step: 5 } } } }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("workflowSettings.JOBS.limits.step");
  });

  it("checks values as wrangler does", () => {
    for (const bad of [
      { limits: { steps: 0 } },
      { limits: { steps: 1.5 } },
      { concurrency: { limit: 0 } },
      { schedules: [] },
      { schedules: [""] },
      { default_retention: { success_retention: 0 } },
      { default_retention: { error_retention: "" } },
    ]) {
      expect(workflowSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const good of [
      {},
      { limits: {} },
      { schedules: ["0 3 * * *", "*/30 * * * *"] },
      { default_retention: { success_retention: 1 } },
    ]) {
      expect(workflowSettingsSchema.safeParse(good).success, JSON.stringify(good)).toBe(true);
    }
  });

  it("must name a Workflow binding of the Worker that defines its Workflow", () => {
    const unbound = artifactManifestSchema.safeParse(
      artifact({ workflowSettings: { OTHER: settings } }),
    );
    expect(unbound.success).toBe(false);
    expect(unbound.error?.issues).toEqual([
      expect.objectContaining({
        path: ["worker", "workflowSettings"],
        message:
          "Workflow settings are recorded for OTHER, but the Worker has no Workflow binding by that name.",
      }),
    ]);
    expect(
      workflowSettingsProblems({
        bindings: [
          {
            type: "workflow",
            name: "AUDIT",
            workflow_name: "site-audit",
            class_name: "SiteAudit",
            script_name: "{{workerName:audit}}",
          },
        ],
        workflowSettings: { AUDIT: settings },
      }),
    ).toEqual([
      "Workflow settings are recorded for AUDIT, which runs a Workflow another Worker defines; settings belong to the Worker that defines it.",
    ]);
  });
});

describe("a Workflow on a schedule", () => {
  const scheduled = { workflowSettings: { JOBS: { schedules: ["0 3 * * *"] } } };

  it("needs the catalog manifest to say plan paid", () => {
    const result = artifactManifestSchema.safeParse(artifact(scheduled));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ["catalog", "plan"],
        message:
          'the Workflow binding JOBS runs its Workflow on a schedule, which Cloudflare offers only on Workers Paid; set "plan": "paid" in the catalog manifest',
      }),
    ]);
    expect(
      artifactManifestSchema.parse(artifact(scheduled, "paid")).worker.workflowSettings,
    ).toEqual({ JOBS: { schedules: ["0 3 * * *"] } });
  });

  it("is the only Workflow setting that does", () => {
    expect(scheduledWorkflowPlanProblem([{ workflowSettings: { JOBS: settings } }], "free")).toBe(
      null,
    );
    expect(scheduledWorkflowPlanProblem([{}], "free")).toBe(null);
    expect(
      scheduledWorkflowPlanProblem(
        [scheduled, { workflowSettings: { SWEEP: { schedules: ["@daily"] } } }],
        "free",
      ),
    ).toMatch(/^the Workflow bindings JOBS, SWEEP run their Workflows on a schedule/);
    expect(scheduledWorkflowPlanProblem([scheduled], "paid")).toBe(null);
  });
});
