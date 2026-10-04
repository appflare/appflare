import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  acceptedOf,
  pendingOf,
  readAcceptedBypass,
  writeAcceptedBypass,
} from "./accepted-paths.server";

beforeEach(async () => {
  await reset();
});

async function insertInstall(id: string, manifest: unknown, digest: string) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       artifact_digest, status, manifest_json, installed_at, updated_at)
     VALUES (?1, 'cut', ?1, ?1, '1.0.0', 'https://artifacts.test/cut.zip', ?2, 'installed', ?3, 1, 1)`,
  )
    .bind(id, digest, JSON.stringify(manifest))
    .run();
}

async function protect(id: string, appId: string | null = `app-${id}`) {
  await env.DB.prepare(
    `INSERT INTO install_access (install_id, access_app_id, token_id, token_client_id,
       token_secret, created_at, updated_at) VALUES (?1, ?2, 't', 'c', 's', 1, 1)`,
  )
    .bind(id, appId)
    .run();
}

describe("accepted public paths", () => {
  it("makes public only what the entry lists and an admin accepted", () => {
    expect(acceptedOf(["/s/*", "/x/*"], ["/s/*", "/old/*"])).toEqual(["/s/*"]);
    expect(pendingOf(["/s/*", "/x/*"], ["/s/*", "/old/*"])).toEqual(["/x/*"]);
  });

  it("are recorded for a protected install only, and read as none otherwise", async () => {
    await createMigrator(migrations).ensure(env.DB);
    await insertInstall("i1", {}, "a".repeat(64));
    await insertInstall("i2", {}, "b".repeat(64));
    await protect("i1");
    await protect("i2", null);
    const orm = createDb(env.DB);
    await writeAcceptedBypass(orm, "i1", ["/s/*", "/s/*", "/x/*"]);
    await writeAcceptedBypass(orm, "i2", ["/s/*"]);
    expect(await readAcceptedBypass(orm, "i1")).toEqual(["/s/*", "/x/*"]);
    expect(await readAcceptedBypass(orm, "i2")).toEqual([]);
    expect(await readAcceptedBypass(orm, "nobody")).toEqual([]);
  });

  it("are filled in for apps protected before they were recorded, from the revision or the release", async () => {
    // The database as it was before the column existed.
    const before = migrations.findIndex((m) => m.tag === "0006_access_accepted_bypass");
    expect(before).toBeGreaterThan(0);
    await createMigrator(migrations.slice(0, before)).ensure(env.DB);
    await insertInstall("rel", { catalog: { access: { bypass: ["/s/*"] } } }, "a".repeat(64));
    await insertInstall("rev", { catalog: { access: { bypass: ["/s/*"] } } }, "b".repeat(64));
    await insertInstall("none", { catalog: {} }, "c".repeat(64));
    await insertInstall("off", { catalog: { access: { bypass: ["/s/*"] } } }, "d".repeat(64));
    await env.DB.prepare(
      `INSERT INTO catalog_revisions (artifact_digest, revision, sha256, key_id, signature,
         catalog_json, recorded_at) VALUES (?1, 2, 'x', 'k', 'sig', ?2, 1)`,
    )
      .bind("b".repeat(64), JSON.stringify({ access: { bypass: ["/x/*"] } }))
      .run();
    for (const id of ["rel", "rev", "none"]) await protect(id);
    await protect("off", null);
    await createMigrator(migrations).ensure(env.DB);
    const orm = createDb(env.DB);
    expect(await readAcceptedBypass(orm, "rel")).toEqual(["/s/*"]);
    expect(await readAcceptedBypass(orm, "rev")).toEqual(["/x/*"]);
    expect(await readAcceptedBypass(orm, "none")).toEqual([]);
    const off = await env.DB.prepare(
      "SELECT accepted_bypass_json AS json FROM install_access WHERE install_id = 'off'",
    ).first<{ json: string | null }>();
    expect(off?.json).toBeNull();
  });
});
