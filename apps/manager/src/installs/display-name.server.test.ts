import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { RenameInstallError, renameInstallCore } from "./display-name.server";

/** Display names in D1: renaming, clearing, and the names older managers recorded. */

async function install(id: string, workerName: string, instanceName: string | null) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       status, installed_at, updated_at)
     VALUES (?1, 'cut', ?2, ?3, '1.0.0', 'u', 'installed', 1, 5)`,
  )
    .bind(id, workerName, instanceName)
    .run();
}

const names = async () =>
  (
    await env.DB.prepare(
      "SELECT id, display_name, instance_name, updated_at FROM installs ORDER BY id",
    ).all()
  ).results;

describe("renameInstallCore", () => {
  beforeEach(async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await install("a", "cut", "cut");
  });

  it("sets the display name, keeps the older label in step, and leaves the rest alone", async () => {
    await expect(renameInstallCore(env.DB, "a", "Team links")).resolves.toEqual({
      displayName: "Team links",
    });
    expect(await names()).toEqual([
      { id: "a", display_name: "Team links", instance_name: "Team links", updated_at: 5 },
    ]);
  });

  it("clears it, so the Worker name shows again", async () => {
    await renameInstallCore(env.DB, "a", "Team links");
    await renameInstallCore(env.DB, "a", null);
    expect(await names()).toEqual([
      { id: "a", display_name: null, instance_name: "cut", updated_at: 5 },
    ]);
  });

  it("refuses an install that does not exist", async () => {
    await expect(renameInstallCore(env.DB, "nope", "x")).rejects.toThrow(RenameInstallError);
  });
});
