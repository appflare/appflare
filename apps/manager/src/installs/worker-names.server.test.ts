import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { takenWorkerNames } from "./worker-names.server";

async function install(id: string, workerName: string, status: string) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url,
       status, installed_at, updated_at)
     VALUES (?1, 'cut', ?2, '1.0.0', 'u', ?3, 1, 1)`,
  )
    .bind(id, workerName, status)
    .run();
}

describe("takenWorkerNames", () => {
  beforeEach(async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await install("a", "cut", "installed");
    await install("b", "cut-2", "installing");
    await install("c", "cut-old", "uninstalled");
  });

  it("lists the Workers of installs that are not uninstalled, and the account's", async () => {
    const names = await takenWorkerNames({
      db: env.DB,
      listAccountWorkers: async () => ["cut", "appflare", "blog"],
    });
    expect(names.installed.sort()).toEqual(["cut", "cut-2"]);
    expect(names.account).toEqual(["cut", "appflare", "blog"]);
  });

  it("still answers with the installs when the account cannot be listed", async () => {
    const names = await takenWorkerNames({
      db: env.DB,
      listAccountWorkers: async () => {
        throw new Error("Authentication error");
      },
    });
    expect(names.installed.sort()).toEqual(["cut", "cut-2"]);
    expect(names.account).toBeNull();
  });
});
