import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { FAKE_ACC, fakeAccessAccount } from "../test/fake-access-account";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { readInstallAccessView } from "./app-access.server";
import { USERS_POLICY_NAME } from "./install-access.server";
import { protectInstall } from "./protect.server";
import { checkProtectedAppsExist } from "./upkeep.server";

/**
 * The cron's check that protected apps' Access applications and the
 * "Appflare users" policy still exist, against a stateful fake account.
 */

const AUTH = "auth-secret-0123456789abcdef0123456789";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const I2 = "i2";

function manifest(bypass?: string[]) {
  return JSON.stringify({
    version: "1.0.0",
    catalog: { name: "Cut", ...(bypass === undefined ? {} : { access: { bypass } }) },
    worker: {},
  });
}

async function seed(bypass?: string[]) {
  await seedInstall({
    manifestJson: manifest(bypass),
    resources: [{ kind: "worker", name: "cut", cfId: "cut" }],
  });
}

async function addSecondInstall() {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       status, manifest_json, installed_at, updated_at)
     VALUES (?1, 'notes', 'notes', 'notes', '1.0.0', 'https://artifacts.test/n.zip', 'installed',
       ?2, 1, 1)`,
  )
    .bind(I2, manifest())
    .run();
  await env.DB.prepare(
    `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
     VALUES ('i2:worker:notes', ?1, 'worker', NULL, 'notes', 'notes', 1)`,
  )
    .bind(I2)
    .run();
}

function setup() {
  const cf = fakeAccessAccount({ now: () => NOW });
  cf.scripts.push({ id: "cut", tag: "tag-cut" }, { id: "notes", tag: "tag-notes" });
  const deps = { db: env.DB, client: cf.client, authSecret: AUTH, now: () => NOW };
  const check = () =>
    checkProtectedAppsExist({ db: env.DB, client: async () => cf.client, now: () => NOW });
  return { cf, deps, check };
}

async function repairOf(installId: string) {
  return (await readInstallAccessView(env.DB, installId))?.repair;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await createDb(env.DB)
    .insert(user)
    .values({ id: "u1", name: "Owner", email: "owner@example.com", role: "admin" });
});

describe("checkProtectedAppsExist", () => {
  it("reads nothing while no app is protected", async () => {
    await seed();
    const { cf, check } = setup();
    expect((await check()).skipped).toBe(true);
    expect(cf.calls).toEqual([]);
  });

  it("marks an app whose Access application was deleted, with two reads, until it is protected again", async () => {
    await seed();
    const { cf, deps, check } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    expect(await repairOf(INSTALL_ID)).toBeNull();

    cf.calls.length = 0;
    expect(await check()).toMatchObject({ skipped: false, missing: [], usersPolicy: "present" });
    expect(cf.keys()).toEqual([
      "GET /access/apps",
      expect.stringMatching(/^GET \/access\/policies\//),
    ]);

    cf.apps.clear();
    expect((await check()).missing).toEqual([INSTALL_ID]);
    expect(await repairOf(INSTALL_ID)).toBe("app-deleted");
    // Marked once; the next run finds nothing new.
    expect((await check()).missing).toEqual([]);

    await protectInstall(deps, { installId: INSTALL_ID });
    expect(await repairOf(INSTALL_ID)).toBeNull();
    expect(await check()).toMatchObject({ missing: [], found: [] });
  });

  it("does not mark an app the listing left out but Cloudflare still has", async () => {
    await seed();
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    // A short listing: the application is on a page the answer did not report.
    const shortClient = {
      ...cf.client,
      access: { ...cf.client.access, listApps: async () => [] },
    } as typeof cf.client;
    const result = await checkProtectedAppsExist({
      db: env.DB,
      client: async () => shortClient,
      now: () => NOW,
    });
    expect(result.missing).toEqual([]);
    expect(cf.keys()).toContainEqual(expect.stringMatching(/^GET \/access\/apps\/[^/]+$/));
    expect(await repairOf(INSTALL_ID)).toBeNull();
  });

  it("marks an app whose public paths' application was deleted", async () => {
    await seed(["/s/*"]);
    const { cf, deps, check } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const bypass = [...cf.apps.values()].find((a) => String(a.name).endsWith("public paths"));
    expect(bypass).toBeDefined();
    cf.apps.delete(bypass?.id ?? "");
    expect((await check()).missing).toEqual([INSTALL_ID]);
    expect(await repairOf(INSTALL_ID)).toBe("app-deleted");
  });

  it("reports a listing it may not make, and still checks the users policy", async () => {
    await seed();
    const { cf, deps, check } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    cf.forbidden.add(`GET /accounts/${FAKE_ACC}/access/apps`);
    const result = await check();
    expect(result.listError).toContain("403");
    expect(result.missing).toEqual([]);
    expect(result.usersPolicy).toBe("present");
    expect(await repairOf(INSTALL_ID)).toBeNull();
  });

  it("makes a deleted users policy again, so every protected app needs protecting again", async () => {
    await seed();
    await addSecondInstall();
    const { cf, deps, check } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await protectInstall(deps, { installId: I2 });
    const old = [...cf.policies.values()].find((p) => p.name === USERS_POLICY_NAME);
    cf.policies.delete(old?.id ?? "");

    const result = await check();
    expect(result.usersPolicy).toBe("recreated");
    const made = [...cf.policies.values()].find((p) => p.name === USERS_POLICY_NAME);
    expect(made?.id).not.toBe(old?.id);
    expect(await repairOf(INSTALL_ID)).toBe("users-policy-replaced");
    expect(await repairOf(I2)).toBe("users-policy-replaced");

    await protectInstall(deps, { installId: INSTALL_ID });
    expect(await repairOf(INSTALL_ID)).toBeNull();
    expect(await repairOf(I2)).toBe("users-policy-replaced");
  });
});
