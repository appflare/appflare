import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ScheduledUpdatesEnv } from "../auto-update/cron.server";
import { lookupOf } from "../catalog/merged.server";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  type ArtifactFixture,
  type ArtifactFixtureOptions,
  buildArtifactFixture,
} from "../test/artifact-fixture";
import { INSTALL_ID, type SeedResource, seedInstall } from "../test/seed-install";
import { updateAllSummary } from "./update-all";
import { startAllUpdatesCore } from "./update-all.server";

/**
 * "Update all" against the local D1, with the Workflow binding replaced by
 * a recorder. The start path is the Update button's, so what it refuses or
 * asks for is real.
 */

const RESOURCES: SeedResource[] = [
  { kind: "worker", name: "cut", cfId: "cut" },
  { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" },
];

const NEW_APP: ArtifactFixtureOptions = { version: "1.1.0" };

function jobs(): ScheduledUpdatesEnv["JOBS"] & { created: { id: string }[] } {
  const created: { id: string }[] = [];
  return {
    created,
    async create({ id }) {
      created.push({ id });
      return { id };
    },
    async get() {
      return { status: async () => ({ status: "running" }) };
    },
  };
}

async function addInstall(
  id: string,
  opts: { name?: string; installedAt?: number; buildKind?: string } = {},
) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, display_name, catalog_version,
       artifact_url, status, build_kind, installed_at, updated_at)
     VALUES (?1, 'cut', ?1, ?2, '1.0.0', 'https://artifacts.test/cut/old.zip', 'installed', ?3, ?4, ?4)`,
  )
    .bind(id, opts.name ?? null, opts.buildKind ?? "artifact", opts.installedAt ?? 2)
    .run();
  await env.DB.prepare(
    `INSERT INTO resources (id, install_id, kind, binding, name, created_at)
     VALUES (?1 || ':secret:ADMIN_PASSWORD', ?1, 'secret', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD', 1)`,
  )
    .bind(id)
    .run();
}

async function run(fixture: ArtifactFixture, installIds: string[]) {
  const JOBS = jobs();
  const ids = ["job1", "job2", "job3", "job4"];
  const outcome = await startAllUpdatesCore(
    { DB: env.DB, KV: env.KV, JOBS, APPFLARE_VERSION: "0.5.0", CF_API_TOKEN: "cf-token" },
    {
      loadManifest: async () => fixture.manifest,
      newId: () => ids.shift() ?? "job-x",
      now: () => new Date("2026-09-24T12:00:00.000Z"),
    },
    lookupOf([fixture.index]),
    { installIds },
  );
  const rows = (
    await env.DB.prepare("SELECT id, install_id, started_by FROM jobs ORDER BY id").all<{
      id: string;
      install_id: string;
      started_by: string;
    }>()
  ).results;
  return { outcome, created: JOBS.created, rows };
}

let fixture: ArtifactFixture;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall({ resources: RESOURCES });
  fixture = await buildArtifactFixture(NEW_APP);
});

describe("startAllUpdatesCore", () => {
  it("starts every listed update that needs nothing, recorded as started by an admin", async () => {
    await addInstall("i2", { name: "Links" });
    const r = await run(fixture, [INSTALL_ID, "i2"]);
    expect(r.outcome).toEqual({
      started: [
        { installId: INSTALL_ID, label: "cut", version: "1.1.0", jobId: "job1" },
        { installId: "i2", label: "Links", version: "1.1.0", jobId: "job2" },
      ],
      needsInput: [],
      notStarted: [],
    });
    expect(r.rows).toEqual([
      { id: "job1", install_id: INSTALL_ID, started_by: "admin" },
      { id: "job2", install_id: "i2", started_by: "admin" },
    ]);
    expect(updateAllSummary(r.outcome)).toBe("2 updates started");
  });

  it("lists an update that introduces a secret for the admin instead of starting it", async () => {
    const withSecret = await buildArtifactFixture({
      ...NEW_APP,
      catalog: {
        secrets: [
          { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
          { name: "API_KEY", label: "API key" },
        ],
      },
    });
    const r = await run(withSecret, [INSTALL_ID]);
    expect(r.created).toEqual([]);
    expect(r.outcome.needsInput).toEqual([
      {
        installId: INSTALL_ID,
        label: "cut",
        version: "1.1.0",
        reason: "It needs a value for API_KEY.",
      },
    ]);
    expect(updateAllSummary(r.outcome)).toBe("No update started, 1 left for you");
  });

  it("lists builds to approve and versions that failed before, without trying them", async () => {
    await addInstall("sb", { name: "Built", buildKind: "sandbox" });
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_by)
       VALUES ('old', ?1, 'update', 'failed', '{"version":"1.1.0"}', 'admin')`,
    )
      .bind(INSTALL_ID)
      .run();
    const r = await run(fixture, ["sb", INSTALL_ID]);
    expect(r.created).toEqual([]);
    expect(r.outcome.needsInput.map((i) => [i.installId, i.reason])).toEqual([
      ["sb", "It is built in your account or runs its own installer, which you approve each time."],
      [INSTALL_ID, "An update to this version failed before."],
    ]);
  });

  it("says why an update could not start, and skips what is already current", async () => {
    await addInstall("busy");
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json)
       VALUES ('running', 'busy', 'reconfigure', 'running', '{}')`,
    ).run();
    await addInstall("updating");
    await env.DB.prepare("UPDATE installs SET status = 'updating' WHERE id = 'updating'").run();
    await addInstall("current");
    await env.DB.prepare(
      "UPDATE installs SET catalog_version = '1.1.0' WHERE id = 'current'",
    ).run();
    const r = await run(fixture, ["busy", "updating", "current", "unknown", INSTALL_ID]);
    expect(r.outcome.started.map((s) => s.installId)).toEqual([INSTALL_ID]);
    expect(r.outcome.notStarted.map((i) => i.installId)).toEqual(["busy", "updating"]);
    expect(r.outcome.notStarted[0]?.reason).toContain("Another job of this install");
    expect(r.outcome.notStarted[1]?.reason).toContain("is running");
  });
});
