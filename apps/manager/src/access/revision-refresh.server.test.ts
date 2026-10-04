import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { readCatalogRevision } from "../catalog/revisions.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { type ArtifactFixture, buildArtifactFixture, REVISED_URL } from "../test/artifact-fixture";
import { fakeAccessAccount } from "../test/fake-access-account";
import { SUBDOMAIN } from "../test/fake-account";
import { recordProtectedInstall } from "../test/protected-install";
import { setInstallRelease } from "../test/recorded-revision";
import { cacheIndex, INSTALL_ID, seedInstall } from "../test/seed-install";
import {
  protectInstall,
  readInstallProtection,
  resyncInstallAccessIfFailed,
} from "./protect.server";
import { refreshProtectedRevisions } from "./revision-refresh.server";

const AUTH = "auth-secret-0123456789abcdef0123456789";
const HOST = `cut.${SUBDOMAIN}.workers.dev`;

function serving(f: ArtifactFixture, broken = false) {
  const hits: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    hits.push(url);
    if (broken && url === REVISED_URL) return new Response("gone", { status: 404 });
    return f.serve(url, init) ?? new Response("not found", { status: 404 });
  };
  return { fetch, hits };
}

/** Install `i1` of the fixture's release, protected, its revision listed but not recorded. */
async function protectedInstallOf(f: ArtifactFixture) {
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
  return access;
}

const bypassUris = (access: ReturnType<typeof fakeAccessAccount>) =>
  [...access.apps.values()]
    .filter((a) => String(a.name).endsWith("public paths"))
    .flatMap((a) => (a.destinations as Array<{ uri: string }>).map((d) => d.uri));

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("refreshProtectedRevisions", () => {
  it("records a newer revision of a protected app's release, and the Access resync follows it in the same run", async () => {
    // Released with two public paths; the catalog has since revised it to drop one.
    const f = await buildArtifactFixture({
      catalog: { access: { bypass: ["/s/*", "/old/*"] } },
      revision: { access: { bypass: ["/s/*"] } },
    });
    const access = await protectedInstallOf(f);
    expect(bypassUris(access)).toEqual([`${HOST}/s/*`, `${HOST}/old/*`]);
    const { fetch, hits } = serving(f);
    const opts = { manifestOptions: { fetch, signingKeys: f.keys } };
    expect(await refreshProtectedRevisions({ DB: env.DB, KV: env.KV }, opts)).toEqual([
      { installId: INSTALL_ID, outcome: "recorded" },
    ]);
    expect((await readCatalogRevision(createDb(env.DB), f.digest))?.revision).toBe(2);
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.syncFailedAt).not.toBeNull();
    await resyncInstallAccessIfFailed({ db: env.DB, client: async () => access.client });
    expect(bypassUris(access)).toEqual([`${HOST}/s/*`]);

    // Nothing newer: no fetch at all.
    hits.length = 0;
    expect(await refreshProtectedRevisions({ DB: env.DB, KV: env.KV }, opts)).toEqual([
      { installId: INSTALL_ID, outcome: "current" },
    ]);
    expect(hits).toEqual([]);
  });

  it("reports a revision it cannot read, and never throws", async () => {
    const f = await buildArtifactFixture({ revision: { access: { bypass: ["/s/*"] } } });
    await protectedInstallOf(f);
    const { fetch } = serving(f, true);
    const [check] = await refreshProtectedRevisions(
      { DB: env.DB, KV: env.KV },
      { manifestOptions: { fetch, signingKeys: f.keys } },
    );
    expect(check).toMatchObject({ installId: INSTALL_ID, outcome: "failed" });
    expect(await readCatalogRevision(createDb(env.DB), f.digest)).toBeNull();
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.syncFailedAt).toBeNull();
  });

  it("checks only protected installs, a few a run, going on from where the last run stopped", async () => {
    const f = await buildArtifactFixture();
    await protectedInstallOf(f);
    for (const id of ["i2", "i3"]) {
      await env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
           artifact_url, artifact_digest, pin_sha, status, current_version_id, config_json,
           manifest_json, installed_at, updated_at)
         SELECT ?1, app_slug, ?1, ?1, catalog_version, artifact_url, artifact_digest, pin_sha,
           status, current_version_id, config_json, manifest_json, installed_at, updated_at
         FROM installs WHERE id = ?2`,
      )
        .bind(id, INSTALL_ID)
        .run();
    }
    // i3 is not protected.
    await recordProtectedInstall({ installId: "i2", authSecret: AUTH, secret: "s" });
    const run = async () =>
      (await refreshProtectedRevisions({ DB: env.DB, KV: env.KV }, { limit: 1 })).map(
        (r) => r.installId,
      );
    expect(await run()).toEqual(["i1"]);
    expect(await run()).toEqual(["i2"]);
    expect(await run()).toEqual(["i1"]);
    // Nothing protected: nothing read, nothing written.
    await env.DB.prepare("UPDATE install_access SET access_app_id = NULL").run();
    expect(await refreshProtectedRevisions({ DB: env.DB, KV: env.KV })).toEqual([]);
  });
});
