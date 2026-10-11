import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { FAKE_ACC, fakeAccessAccount } from "../test/fake-access-account";
import { SUBDOMAIN } from "../test/fake-account";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { readInstallAccessView } from "./app-access.server";
import { USERS_POLICY_NAME } from "./install-access.server";
import {
  protectInstall,
  readInstallProtection,
  syncInstallAccessDestinations,
} from "./protect.server";
import { checkProtectedAppsExist, DELETION_CHECKS_PER_RUN } from "./upkeep.server";

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

  it("frees an address left to another application once none names it, marking the app due, not failed", async () => {
    await seed();
    const { cf, deps, check } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const worker = { type: "worker", worker_id: "tag-cut" };
    // What a sync left to two other applications; only "Team" is still there.
    cf.apps.set("team", {
      id: "team",
      aud: "aud-team",
      name: "Team",
      destinations: [{ type: "public", uri: "t.example.com" }],
      policies: [],
    });
    await env.DB.prepare("UPDATE install_access SET access_destinations_json = ?1")
      .bind(
        JSON.stringify({
          destinations: [worker],
          workerTags: { cut: "tag-cut" },
          taken: [
            { uri: "links.example.com", app: "Links admin" },
            { uri: "t.example.com", app: "Team" },
          ],
        }),
      )
      .run();
    expect((await check()).freed).toEqual([{ installId: INSTALL_ID, uris: ["links.example.com"] }]);
    const protection = await readInstallProtection(env.DB, INSTALL_ID);
    expect(protection).toMatchObject({ resyncDueAt: NOW, syncFailedAt: null });
    expect(protection?.coverage?.taken).toEqual([{ uri: "t.example.com", app: "Team" }]);
    // Nothing failed: nothing to repair on the app's page.
    expect(await repairOf(INSTALL_ID)).toBeNull();
    // Freed once; the next run finds nothing new.
    expect((await check()).freed).toEqual([]);
  });

  it("never marks an app whose application was deleted due, so no resync fails on it", async () => {
    await seed();
    const { cf, deps, check } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    // An address left to an application that is gone, and one made by hand
    // over every workers.dev address: either would mark the app due.
    const coverage = (await readInstallProtection(env.DB, INSTALL_ID))?.coverage;
    await env.DB.prepare("UPDATE install_access SET access_destinations_json = ?1")
      .bind(JSON.stringify({ ...coverage, taken: [{ uri: "links.example.com", app: "Gone" }] }))
      .run();
    cf.apps.clear();
    cf.apps.set("team", {
      id: "team",
      aud: "aud-team",
      name: "Workers",
      destinations: [{ type: "public", uri: `*.${SUBDOMAIN}.workers.dev` }],
      policies: [],
    });
    for (const missing of [[INSTALL_ID], []]) {
      expect(await check()).toMatchObject({ missing, freed: [], patterns: [] });
      expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({
        resyncDueAt: null,
        syncFailedAt: null,
        appMissingAt: NOW,
      });
    }
    expect(await repairOf(INSTALL_ID)).toBe("app-deleted");
  });

  it("marks an app due when what it names of its version previews is out of step", async () => {
    await seed();
    const { cf, deps, check } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const previews = `*-cut.${SUBDOMAIN}.workers.dev`;
    const named = async () =>
      (await readInstallProtection(env.DB, INSTALL_ID))?.coverage?.destinations.some(
        (d) => d.type === "public" && d.uri === previews,
      );
    const resync = async () => {
      await syncInstallAccessDestinations(deps, INSTALL_ID);
      expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({ resyncDueAt: null });
    };
    // Nothing covers the previews more broadly: in step, and no script list read.
    cf.calls.length = 0;
    expect((await check()).patterns).toEqual([]);
    expect(cf.keys()).not.toContain("GET /workers/scripts");

    // An application made by hand for every workers.dev address: the previews must be named.
    cf.apps.set("team", {
      id: "team",
      aud: "aud-team",
      name: "Workers",
      destinations: [{ type: "public", uri: `*.${SUBDOMAIN}.workers.dev` }],
      policies: [],
    });
    cf.calls.length = 0;
    expect((await check()).patterns).toEqual([INSTALL_ID]);
    expect(cf.keys().filter((k) => k === "GET /workers/scripts")).toHaveLength(1);
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({
      resyncDueAt: NOW,
      syncFailedAt: null,
    });
    await resync();
    expect(await named()).toBe(true);
    expect((await check()).patterns).toEqual([]);

    // Another app's Worker whose address the pattern matches: the pattern must go.
    cf.scripts.push({ id: "browser-cut", tag: "tag-browser-cut" });
    expect((await check()).patterns).toEqual([INSTALL_ID]);
    await resync();
    expect(await named()).toBe(false);
    expect((await check()).patterns).toEqual([]);

    // That Worker gone again: named again.
    cf.scripts.pop();
    expect((await check()).patterns).toEqual([INSTALL_ID]);
    await resync();
    expect(await named()).toBe(true);
    // The broader application gone: the Worker's destination covers them again.
    cf.apps.delete("team");
    expect((await check()).patterns).toEqual([INSTALL_ID]);
    await resync();
    expect(await named()).toBe(false);
    expect((await check()).patterns).toEqual([]);
  });

  it("marks an app due when what it names of its wildcard domain is out of step", async () => {
    await seed();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('wild', ?1, 'wildcard_domain', NULL, 't.example.com', 'zone-1', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    const { cf, deps, check } = setup();
    cf.scripts[0] = {
      id: "cut",
      tag: "tag-cut",
      routes: [{ id: "r1", pattern: "*.t.example.com/*", script: "cut" }],
    };
    await protectInstall(deps, { installId: INSTALL_ID });
    const named = async () =>
      (await readInstallProtection(env.DB, INSTALL_ID))?.coverage?.destinations.flatMap((d) =>
        d.type === "public" && d.uri.endsWith("t.example.com") ? [d.uri] : [],
      );
    const resync = async () => {
      await syncInstallAccessDestinations(deps, INSTALL_ID);
      expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({ resyncDueAt: null });
    };
    // Nothing covers it more broadly: in step, and the account's Workers not read.
    cf.calls.length = 0;
    expect((await check()).patterns).toEqual([]);
    expect(cf.keys()).not.toContain("GET /workers/domains");
    expect(await named()).toEqual([]);

    // An application made by hand for every name of the zone: the base and its names must be named.
    cf.apps.set("corp", {
      id: "corp",
      aud: "aud-c",
      name: "Example",
      destinations: [{ type: "public", uri: "*.example.com" }],
      policies: [],
    });
    cf.calls.length = 0;
    expect((await check()).patterns).toEqual([INSTALL_ID]);
    expect(cf.keys().filter((k) => k === "GET /workers/domains")).toHaveLength(1);
    await resync();
    expect(await named()).toEqual(["t.example.com", "*.t.example.com"]);
    expect((await check()).patterns).toEqual([]);

    // Another Worker's route under the base: the names must go, the base stays.
    cf.scripts.push({
      id: "eu",
      tag: "tag-eu",
      routes: [{ id: "r2", pattern: "*.eu.t.example.com/*", script: "eu" }],
    });
    expect((await check()).patterns).toEqual([INSTALL_ID]);
    await resync();
    expect(await named()).toEqual(["t.example.com"]);
    expect((await check()).patterns).toEqual([]);

    // The broader application gone: the Worker's destination covers both again.
    cf.apps.delete("corp");
    expect((await check()).patterns).toEqual([INSTALL_ID]);
    await resync();
    expect(await named()).toEqual([]);
    expect((await check()).patterns).toEqual([]);
  });

  it("marks an app due when another application covers a hostname Cloudflare's limit left out", async () => {
    await seed();
    const { cf, deps, check } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const domains = Array.from({ length: 55 }, (_, i) => `d${i}.example.com`);
    for (const domain of domains) {
      await env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES (?1, ?2, 'domain', NULL, ?3, NULL, 2)`,
      )
        .bind(`i1:domain:${domain}`, INSTALL_ID, domain)
        .run();
    }
    await syncInstallAccessDestinations(deps, INSTALL_ID);
    const overLimit = async () =>
      (await readInstallProtection(env.DB, INSTALL_ID))?.coverage?.overLimit ?? [];
    const left = await overLimit();
    expect(left).toContain("d9.example.com");
    const resync = async () => {
      await syncInstallAccessDestinations(deps, INSTALL_ID);
      expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({ resyncDueAt: null });
    };
    // Nothing else covers them: in step, with no read besides the usual two.
    cf.calls.length = 0;
    expect((await check()).patterns).toEqual([]);
    expect(cf.keys()).toEqual([
      "GET /access/apps",
      expect.stringMatching(/^GET \/access\/policies\//),
    ]);

    // An application made later for a broader pattern: the hostname must be named.
    cf.apps.set("nines", {
      id: "nines",
      aud: "aud-n",
      name: "Nines",
      destinations: [{ type: "public", uri: "d9*.example.com" }],
      policies: [],
    });
    expect((await check()).patterns).toEqual([INSTALL_ID]);
    await resync();
    expect(await overLimit()).not.toContain("d9.example.com");
    const appId = (await readInstallProtection(env.DB, INSTALL_ID))?.accessAppId ?? "";
    expect(cf.apps.get(appId)?.destinations).toContainEqual({
      type: "public",
      uri: "d9.example.com",
    });
    expect((await check()).patterns).toEqual([]);

    // One made for exactly one of them: left to it, which the app's page shows.
    const exact = (await overLimit())[0] ?? "";
    cf.apps.set("exact", {
      id: "exact",
      aud: "aud-e",
      name: "Exact",
      destinations: [{ type: "public", uri: exact }],
      policies: [],
    });
    expect((await check()).patterns).toEqual([INSTALL_ID]);
    await resync();
    expect(await overLimit()).not.toContain(exact);
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.coverage?.taken).toEqual([
      { uri: exact, app: "Exact" },
    ]);
    expect((await check()).patterns).toEqual([]);
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

  it("reads at most a few applications one by one per run, leaving the rest for the next", async () => {
    await seed();
    const { cf } = setup();
    // Twelve protected installs the listing leaves out.
    for (let i = 0; i < 12; i++) {
      await env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
           artifact_url, status, installed_at, updated_at)
         VALUES (?1, 'cut', ?1, ?1, '1.0.0', 'https://artifacts.test/c.zip', 'installed', 1, 1)`,
      )
        .bind(`p${i}`)
        .run();
      await env.DB.prepare(
        `INSERT INTO install_access (install_id, access_app_id, token_id, token_client_id,
           token_secret, created_at, updated_at) VALUES (?1, ?2, 't', 'c', 's', 1, 1)`,
      )
        .bind(`p${i}`, `gone-${i}`)
        .run();
    }
    await checkProtectedAppsExist({ db: env.DB, client: async () => cf.client, now: () => NOW });
    const reads = cf.keys().filter((k) => /^GET \/access\/apps\/[^/]+$/.test(k));
    expect(reads).toHaveLength(DELETION_CHECKS_PER_RUN);
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
