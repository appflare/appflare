import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  type BuildCleanupTarget,
  buildCleanupTargets,
  cleanupRetiredBuilds,
  retiredInstallIds,
} from "./uninstall-builds";

/**
 * Which builds an uninstall deletes: its own prefix, and the prefix of the
 * failed install it replaced when it was installed from that install's
 * build, keeping the versions another install still reads. The same for a
 * failed install retired without an uninstall job.
 */

const zip = (installId: string, version: string) =>
  `https://sandbox/builds/${installId}/${version}/cut-${version}.zip`;

async function install(id: string, status: string, artifactUrl: string) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status,
       installed_at, updated_at, build_kind, origin)
     VALUES (?1, 'repository:me/cut', ?1, '1', ?2, ?3, 1, 1, 'sandbox', 'repository')`,
  )
    .bind(id, artifactUrl, status)
    .run();
}

async function job(id: string, installId: string, kind: string, buildId: string | null) {
  await env.DB.prepare(
    "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES (?1, ?2, ?3, 'succeeded', ?4)",
  )
    .bind(id, installId, kind, JSON.stringify(buildId === null ? {} : { buildId }))
    .run();
}

async function build(id: string, installId: string, status = "used") {
  await env.DB.prepare(
    `INSERT INTO source_builds (id, install_id, purpose, origin, repo, status, created_at, updated_at)
     VALUES (?1, ?2, 'install', 'repository', 'me/cut', ?3, 1, 1)`,
  )
    .bind(id, installId, status)
    .run();
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("buildCleanupTargets", () => {
  it("deletes an install's own builds, every version, when nothing else reads them", async () => {
    await install("a", "uninstalling", zip("a", "1"));
    await build("b1", "a");
    await job("j1", "a", "install", "b1");
    expect(await buildCleanupTargets(env.DB, "a")).toEqual([{ installId: "a", keepVersions: [] }]);
  });

  it("keeps the build of a failed install that the install replacing it reads", async () => {
    // "old" failed and is being removed; "new" installs old's build again.
    await install("old", "uninstalling", zip("old", "1"));
    await build("b1", "old");
    await job("j1", "old", "install", "b1");
    await install("new", "installing", zip("old", "1"));
    await job("j2", "new", "install", "b1");
    expect(await buildCleanupTargets(env.DB, "old")).toEqual([
      { installId: "old", keepVersions: ["1"] },
    ]);

    // Once old is gone, new's uninstall deletes its own builds and old's.
    await env.DB.prepare("UPDATE installs SET status = 'uninstalled' WHERE id = 'old'").run();
    await env.DB.prepare("UPDATE installs SET status = 'uninstalling' WHERE id = 'new'").run();
    expect(await buildCleanupTargets(env.DB, "new")).toEqual([
      { installId: "new", keepVersions: [] },
      { installId: "old", keepVersions: [] },
    ]);
  });

  it("keeps a version a snapshot of another install reads, and never cleans the prefix of an install still there", async () => {
    await install("old", "uninstalled", zip("old", "1"));
    await build("b1", "old");
    // "new" was installed from old's build, then updated: a snapshot still reads old's build.
    await install("new", "installed", zip("new", "2"));
    await job("j3", "new", "update", null);
    await env.DB.prepare(
      `INSERT INTO snapshots (id, install_id, job_id, worker_version_id, d1_bookmarks_json,
         artifact_url, taken_at)
       VALUES ('s1', 'new', 'j3', 'v1', '{}', ?1, 1)`,
    )
      .bind(zip("old", "1"))
      .run();
    // "other" reused the same build too and is being uninstalled.
    await install("other", "uninstalling", zip("old", "1"));
    await job("j4", "other", "install", "b1");
    expect(await buildCleanupTargets(env.DB, "other")).toEqual([
      { installId: "other", keepVersions: [] },
      { installId: "old", keepVersions: ["1"] },
    ]);
    // A build of an install that is still there is that install's to delete.
    await env.DB.prepare("UPDATE installs SET status = 'failed' WHERE id = 'old'").run();
    expect(await buildCleanupTargets(env.DB, "other")).toEqual([
      { installId: "other", keepVersions: [] },
    ]);
  });

  it("keeps the first build while an install made from it twice over still reads it", async () => {
    // "a" failed and is gone; "b", installed from a's build, failed too; "c" installs it again.
    await install("a", "uninstalled", zip("a", "1"));
    await build("b1", "a");
    await job("j1", "a", "install", "b1");
    await install("b", "uninstalling", zip("a", "1"));
    await job("j2", "b", "install", "b1");
    await install("c", "installing", zip("a", "1"));
    await job("j3", "c", "install", "b1");
    expect(await buildCleanupTargets(env.DB, "b")).toEqual([
      { installId: "b", keepVersions: [] },
      { installId: "a", keepVersions: ["1"] },
    ]);
    await env.DB.prepare("UPDATE installs SET status = 'uninstalled' WHERE id = 'b'").run();
    await env.DB.prepare("UPDATE installs SET status = 'uninstalling' WHERE id = 'c'").run();
    expect(await buildCleanupTargets(env.DB, "c")).toEqual([
      { installId: "c", keepVersions: [] },
      { installId: "a", keepVersions: [] },
    ]);
  });

  it("reads jobs without a build, or without JSON, as using none", async () => {
    await install("a", "uninstalling", "https://releases.example/cut-1.zip");
    await job("j1", "a", "install", null);
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('j2', 'a', 'update', 'failed', 'not json')",
    ).run();
    expect(await buildCleanupTargets(env.DB, "a")).toEqual([{ installId: "a", keepVersions: [] }]);
  });
});

describe("cleanupRetiredBuilds", () => {
  it("deletes the builds of each install a statement retired, once, past one that fails", async () => {
    await install("x", "failed", zip("x", "1"));
    await install("y", "failed", zip("y", "1"));
    // A live install reads x's build.
    await install("live", "installing", zip("x", "1"));
    const [result] = await env.DB.batch([
      env.DB.prepare(
        "UPDATE installs SET status = 'uninstalled' WHERE status = 'failed' RETURNING id",
      ),
    ]);
    const retired = retiredInstallIds(result).sort();
    expect(retired).toEqual(["x", "y"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: BuildCleanupTarget[] = [];
    await cleanupRetiredBuilds(env.DB, [...retired, "x"], async (target) => {
      calls.push(target);
      if (target.installId === "x") throw new Error("the sandbox Worker is down");
    });
    expect(calls).toEqual([
      { installId: "x", keepVersions: ["1"] },
      { installId: "y", keepVersions: [] },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
