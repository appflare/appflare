import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { listRecentJobs } from "./job-list.server";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

async function addJob(
  id: string,
  opts: {
    installId?: string | null;
    kind?: string;
    status?: string;
    input?: unknown;
    startedAt?: number | null;
    startedBy?: string;
  } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, install_id, kind, status, input_json, started_by, started_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      opts.installId === undefined ? INSTALL_ID : opts.installId,
      opts.kind ?? "update",
      opts.status ?? "succeeded",
      opts.input === undefined ? null : JSON.stringify(opts.input),
      opts.startedBy ?? "admin",
      opts.startedAt === undefined ? 1_000 : opts.startedAt,
    )
    .run();
}

describe("listRecentJobs", () => {
  it("lists jobs of every install and of Appflare itself, newest first, queued ones on top", async () => {
    await seedInstall();
    await addJob("j-old", { kind: "install", startedAt: 1_000 });
    await addJob("j-new", { kind: "update", startedAt: 3_000, startedBy: "schedule" });
    await addJob("j-self", { installId: null, kind: "self_update", startedAt: 2_000 });
    await addJob("j-queued", { kind: "uninstall", status: "queued", startedAt: null });

    const rows = await listRecentJobs(env.DB);
    expect(rows.map((r) => r.id)).toEqual(["j-queued", "j-new", "j-self", "j-old"]);
    expect(rows[1]).toMatchObject({
      kind: "update",
      startedBy: "schedule",
      install: { id: INSTALL_ID, label: "cut" },
    });
    expect(rows[2]?.install).toBeNull();
    expect(rows[3]?.startedAt).toBe(new Date(1_000).toISOString());
  });

  it("names the install by its display name when it has one", async () => {
    await seedInstall();
    await env.DB.prepare("UPDATE installs SET display_name = 'Team links' WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    await addJob("j1");
    const [row] = await listRecentJobs(env.DB);
    expect(row?.install).toEqual({ id: INSTALL_ID, label: "Team links" });
  });

  it("names an install by the app's name, adding the Worker name only to tell two apart", async () => {
    const manifest = JSON.stringify({ version: "1.0.0", catalog: { name: "Cut" } });
    await seedInstall({ manifestJson: manifest });
    await addJob("j1", { startedAt: 1_000 });
    expect((await listRecentJobs(env.DB))[0]?.install).toEqual({ id: INSTALL_ID, label: "Cut" });

    // A second install of the same app, with no job yet: the first one's jobs now tell it apart.
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status,
         manifest_json, installed_at, updated_at)
       VALUES ('i2', 'cut', 'cut-2', '1.0.0', 'https://artifacts.test/cut/old.zip', 'installed',
         ?1, 2, 2)`,
    )
      .bind(manifest)
      .run();
    expect((await listRecentJobs(env.DB))[0]?.install?.label).toBe("Cut (cut)");
    await addJob("j2", { installId: "i2", startedAt: 2_000 });
    expect((await listRecentJobs(env.DB)).map((r) => r.install?.label)).toEqual([
      "Cut (cut-2)",
      "Cut (cut)",
    ]);

    // Uninstalled, it still shares the list with the other one, so both stay told apart.
    await env.DB.prepare("UPDATE installs SET status = 'uninstalled' WHERE id = 'i2'").run();
    expect((await listRecentJobs(env.DB)).map((r) => r.install?.label)).toEqual([
      "Cut (cut-2)",
      "Cut (cut)",
    ]);
  });

  it("marks a database restore and a deletion of kept data, and stops at the limit", async () => {
    await seedInstall();
    await addJob("j1", { kind: "rollback", input: { restore: true }, startedAt: 1_000 });
    await addJob("j2", { kind: "uninstall", input: { deleteRetained: true }, startedAt: 2_000 });
    await addJob("j3", { kind: "rollback", input: {}, startedAt: 3_000 });

    const rows = await listRecentJobs(env.DB, 2);
    expect(rows.map((r) => [r.id, r.restore, r.deleteRetained])).toEqual([
      ["j3", false, false],
      ["j2", false, true],
    ]);
  });
});
