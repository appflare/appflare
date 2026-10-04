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
import { protectInstall } from "./protect.server";
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
