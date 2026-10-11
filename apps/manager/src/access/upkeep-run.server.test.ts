import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { fakeAccessAccount } from "../test/fake-access-account";
import { SUBDOMAIN } from "../test/fake-account";
import { setInstallRelease } from "../test/recorded-revision";
import { cacheIndex, INSTALL_ID, seedInstall } from "../test/seed-install";
import { PROTECT_MESSAGES, protectInstall, readInstallProtection } from "./protect.server";
import {
  ACCESS_UPKEEP_IN_PLACE,
  ACCESS_UPKEEP_PARTS,
  accessUpkeepNeeded,
  refreshAccessRevisions,
  renewAccessTokens,
  resyncAccessApps,
  runAccessUpkeep,
} from "./upkeep-run.server";

const AUTH = "auth-secret-0123456789abcdef0123456789";
const HOST = `cut.${SUBDOMAIN}.workers.dev`;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("runAccessUpkeep", () => {
  it("is not needed while no app has an Access record", async () => {
    expect(await accessUpkeepNeeded(env.DB)).toBe(false);
  });

  it("reads a revision of a protected app's release and brings its public paths in step in the same run", async () => {
    // Released with two public paths; a revision drops one.
    const f = await buildArtifactFixture({
      catalog: { access: { bypass: ["/s/*", "/old/*"] } },
      revision: { access: { bypass: ["/s/*"] } },
    });
    await seedInstall({
      manifestJson: new TextDecoder().decode(f.manifestBytes),
      resources: [{ kind: "worker", name: "cut", cfId: "cut" }],
    });
    await setInstallRelease(INSTALL_ID, f);
    await createDb(env.DB)
      .insert(user)
      .values({ id: "u1", name: "Owner", email: "owner@example.com", role: "admin" });
    const access = fakeAccessAccount();
    access.scripts.push({ id: "cut", tag: "tag-cut" });
    await protectInstall(
      { db: env.DB, client: access.client, authSecret: AUTH },
      { installId: INSTALL_ID },
    );
    await cacheIndex(f);
    expect(await accessUpkeepNeeded(env.DB)).toBe(true);
    const fetch: FetchLike = async (url, init) =>
      f.serve(url, init) ?? new Response("not found", { status: 404 });
    const report = await runAccessUpkeep(
      { DB: env.DB, KV: env.KV, BETTER_AUTH_SECRET: AUTH },
      {
        client: async () => access.client,
        manifestOptions: { fetch, signingKeys: f.keys },
      },
    );
    expect(report.lines).toContainEqual({
      level: "log",
      message: `access: catalog revision for install ${INSTALL_ID}: recorded`,
    });
    expect(report.lines.map((l) => l.message)).toContainEqual(
      expect.stringMatching(/applications of install i1 brought in step again/),
    );
    const uris = [...access.apps.values()]
      .filter((a) => String(a.name).endsWith("public paths"))
      .flatMap((a) => (a.destinations as Array<{ uri: string }>).map((d) => d.uri));
    expect(uris).toEqual([`${HOST}/s/*`]);
  });

  it("marks every protected app due for one resync when Appflare is updated, without calling it a failure", async () => {
    // The database as it was before the update.
    await reset();
    const before = migrations.findIndex((m) => m.tag === "0008_access_hostnames_resync");
    expect(before).toBeGreaterThan(0);
    await createMigrator(migrations.slice(0, before)).ensure(env.DB);
    for (const [id, appId, failed, missing] of [
      ["p1", "app-1", null, null],
      ["p2", "app-2", 7, null],
      ["gone", "app-3", null, 9],
      ["off", null, null, null],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
           artifact_url, artifact_digest, status, installed_at, updated_at)
         VALUES (?1, 'cut', ?1, ?1, '1.0.0', 'https://artifacts.test/cut.zip', ?2, 'installed', 1, 1)`,
      )
        .bind(id, id.padEnd(64, "0"))
        .run();
      await env.DB.prepare(
        `INSERT INTO install_access (install_id, access_app_id, token_id, token_client_id,
           token_secret, access_sync_failed_at, access_app_missing_at, created_at, updated_at)
         VALUES (?1, ?2, 't', 'c', 's', ?3, ?4, 1, 1)`,
      )
        .bind(id, appId, failed, missing)
        .run();
    }
    await createMigrator(migrations).ensure(env.DB);
    const p1 = await readInstallProtection(env.DB, "p1");
    expect(p1?.resyncDueAt?.getTime()).toBeGreaterThan(Date.parse("2026-01-01"));
    expect(p1?.syncFailedAt).toBeNull();
    // One whose last sync failed is retried anyway, and keeps its failure.
    expect(await readInstallProtection(env.DB, "p2")).toMatchObject({
      syncFailedAt: new Date(7),
      resyncDueAt: null,
    });
    // One whose application was deleted waits for Protect again, which makes a new one.
    expect(await readInstallProtection(env.DB, "gone")).toMatchObject({
      syncFailedAt: null,
      resyncDueAt: null,
      appMissingAt: new Date(9),
    });
    const off = await env.DB.prepare(
      "SELECT access_sync_failed_at AS failed, access_resync_due_at AS due FROM install_access WHERE install_id = 'off'",
    ).first();
    expect(off).toEqual({ failed: null, due: null });
  });

  it("gives an app protected by an earlier version its hostnames once, and leaves one another application names until it is free", async () => {
    await seedInstall({
      resources: [
        { kind: "worker", name: "cut", cfId: "cut" },
        { kind: "domain", name: "links.example.com", cfId: "dom-1" },
      ],
    });
    await createDb(env.DB)
      .insert(user)
      .values({ id: "u1", name: "Owner", email: "owner@example.com", role: "admin" });
    const access = fakeAccessAccount();
    access.scripts.push({ id: "cut", tag: "tag-cut" });
    await protectInstall(
      { db: env.DB, client: access.client, authSecret: AUTH },
      { installId: INSTALL_ID },
    );
    const app = [...access.apps.values()][0];
    if (app === undefined) throw new Error("no app");
    // What an earlier version made and recorded: the Worker alone, then the update's mark.
    const worker = { type: "worker", worker_id: "tag-cut" };
    app.destinations = [worker];
    await env.DB.prepare(
      "UPDATE install_access SET access_destinations_json = ?1, access_resync_due_at = 1",
    )
      .bind(JSON.stringify({ destinations: [worker], workerTags: { cut: "tag-cut" } }))
      .run();
    // Applications made by hand: one for the app's custom domain, one for every workers.dev address.
    for (const [id, name, uri] of [
      ["links", "Links admin", "links.example.com"],
      ["team", "Workers", `*.${SUBDOMAIN}.workers.dev`],
    ] as const) {
      access.apps.set(id, {
        id,
        aud: `aud-${id}`,
        name,
        destinations: [{ type: "public", uri }],
        policies: [],
      });
    }
    const env2 = { DB: env.DB, KV: env.KV, BETTER_AUTH_SECRET: AUTH };
    const deps = { client: async () => access.client };
    const writes = () => access.keys().filter((k) => !k.startsWith("GET "));

    const first = await resyncAccessApps(env2, deps);
    expect(first.lines).toEqual([
      {
        level: "log",
        message: `access: applications of install ${INSTALL_ID} brought in step again: updated`,
      },
      {
        level: "warn",
        message: `access: install ${INSTALL_ID}: ${PROTECT_MESSAGES.taken("Links admin", ["links.example.com"])}`,
      },
    ]);
    expect(access.apps.get(app.id)?.destinations).toEqual([
      { type: "public", uri: HOST },
      { type: "public", uri: `*-${HOST}` },
      worker,
    ]);

    // Once: the next run reads, and writes nothing.
    access.calls.length = 0;
    expect((await resyncAccessApps(env2, deps)).lines).toEqual([]);
    expect(writes()).toEqual([]);

    // The other application deleted: the next run covers the address again.
    access.apps.delete("links");
    access.calls.length = 0;
    const third = await resyncAccessApps(env2, deps);
    expect(third.lines).toEqual([
      {
        level: "log",
        message: `access: install ${INSTALL_ID}: no other Access application names links.example.com any more; brought in step on the resync`,
      },
      {
        level: "log",
        message: `access: applications of install ${INSTALL_ID} brought in step again: updated`,
      },
    ]);
    expect(writes()).toEqual([`PUT /access/apps/${app.id}`]);
    expect(access.apps.get(app.id)?.destinations).toContainEqual({
      type: "public",
      uri: "links.example.com",
    });
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({
      syncFailedAt: null,
      resyncDueAt: null,
    });
  });

  it("leaves a due app for the next run while a job holds the Access lock, without a failure", async () => {
    await seedInstall({
      manifestJson: JSON.stringify({ version: "1.0.0", catalog: { name: "Cut" }, worker: {} }),
      resources: [{ kind: "worker", name: "cut", cfId: "cut" }],
    });
    await createDb(env.DB)
      .insert(user)
      .values({ id: "u1", name: "Owner", email: "owner@example.com", role: "admin" });
    const access = fakeAccessAccount();
    access.scripts.push({ id: "cut", tag: "tag-cut" });
    await protectInstall(
      { db: env.DB, client: access.client, authSecret: AUTH },
      { installId: INSTALL_ID },
    );
    await env.DB.prepare("UPDATE install_access SET access_resync_due_at = 1").run();
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('access_lock', 'a job', ?1)",
    )
      .bind(Date.now())
      .run();
    const report = await resyncAccessApps(
      { DB: env.DB, KV: env.KV, BETTER_AUTH_SECRET: AUTH },
      { client: async () => access.client },
    );
    expect(report.lines).toContainEqual({
      level: "log",
      message: `access: another Access change is in progress; install ${INSTALL_ID} and the rest are brought in step on the next run`,
    });
    expect(report.lines.filter((l) => l.level === "error").map((l) => l.message)).toEqual([
      "access: check that protected apps' Access applications exist failed",
    ]);
    // Still only due: the app's page shows no failure, and the next run tries again.
    expect(await readInstallProtection(env.DB, INSTALL_ID)).toMatchObject({
      syncFailedAt: null,
      resyncDueAt: new Date(1),
    });
  });

  it("runs as three parts, each doing only its own work", async () => {
    const f = await buildArtifactFixture();
    await seedInstall({ manifestJson: new TextDecoder().decode(f.manifestBytes) });
    await env.DB.prepare(
      `INSERT INTO install_access (install_id, access_app_id, token_id, token_client_id,
         token_secret, access_sync_failed_at, created_at, updated_at)
       VALUES (?1, 'app-1', 't', 'c', 's', 1, 1, 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    let asked = 0;
    const deps = {
      client: async () => {
        asked += 1;
        throw new Error("no token");
      },
    };
    const env2 = { DB: env.DB, KV: env.KV };
    // The app is not in any cached catalog, and no token is due: neither asks Cloudflare.
    expect(await refreshAccessRevisions(env2, deps)).toEqual({
      lines: [
        { level: "log", message: `access: catalog revision for install ${INSTALL_ID}: unlisted` },
      ],
    });
    expect(await renewAccessTokens(env2, deps)).toEqual({ lines: [] });
    expect(asked).toBe(0);
    // A resync is due: only this part asks, and reports the failure.
    const resync = await resyncAccessApps(env2, deps);
    expect(asked).toBeGreaterThan(0);
    expect(resync.lines.map((l) => l.error)).toContain("no token");
    expect(Object.keys(ACCESS_UPKEEP_IN_PLACE)).toEqual([...ACCESS_UPKEEP_PARTS]);
  });

  it("reports what failed as lines, and never throws", async () => {
    const f = await buildArtifactFixture();
    await seedInstall({ manifestJson: new TextDecoder().decode(f.manifestBytes) });
    await env.DB.prepare(
      `INSERT INTO install_access (install_id, access_app_id, token_id, token_client_id,
         token_secret, access_sync_failed_at, created_at, updated_at)
       VALUES (?1, 'app-1', 't', 'c', 's', 1, 1, 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    const report = await runAccessUpkeep(
      { DB: env.DB, KV: env.KV },
      {
        client: async () => {
          throw new Error("no token");
        },
      },
    );
    expect(report.lines.filter((l) => l.level === "error").length).toBeGreaterThan(0);
    expect(report.lines.map((l) => l.error)).toContain("no token");
  });
});
