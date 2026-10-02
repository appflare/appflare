import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CatalogManifest } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { recordCatalogRevision } from "../catalog/revisions.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { sha256Hex } from "../jobs/install/artifact";
import { buildArtifactFixture, REVISED_URL } from "../test/artifact-fixture";
import { fakeAccessAccount } from "../test/fake-access-account";
import { SUBDOMAIN } from "../test/fake-account";
import { recordFixtureRevision, setInstallRelease } from "../test/recorded-revision";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { readAcceptedBypass } from "./accepted-paths.server";
import { accessAddressSync } from "./address-sync.server";
import { readInstallAccessView } from "./app-access.server";
import {
  BYPASS_MESSAGES,
  bypassAppResourceId,
  bypassDestinations,
  bypassHosts,
  bypassPathsOfManifest,
  bypassPolicyName,
  MAX_ACCESS_APP_DESTINATIONS,
} from "./bypass.server";
import { makePublicPathsCore } from "./make-public.server";
import {
  protectInstall,
  readInstallProtection,
  resyncInstallAccessIfFailed,
  syncInstallAccessDestinations,
  unprotectInstall,
} from "./protect.server";
import { withAccessLock } from "./toggle.server";

/**
 * The public paths of a protected install (`access.bypass`): one more
 * Access application with a bypass policy and a `public` destination per
 * path on every hostname the app answers on, kept in step with the app's
 * addresses and removed with its protection.
 */

const AUTH = "auth-secret-0123456789abcdef0123456789";
const NOW = new Date("2026-09-30T12:00:00.000Z");
const HOST = `cut.${SUBDOMAIN}.workers.dev`;

function manifestWith(access?: unknown): string {
  return JSON.stringify({
    version: "1.0.0",
    catalog: { name: "Cut", ...(access === undefined ? {} : { access }) },
    worker: {},
  });
}

function setup() {
  const cf = fakeAccessAccount({ now: () => NOW });
  cf.scripts.push({ id: "cut", tag: "tag-cut" });
  const deps = { db: env.DB, client: cf.client, authSecret: AUTH, now: () => NOW };
  return { cf, deps };
}

function bypassApps(cf: ReturnType<typeof fakeAccessAccount>) {
  return [...cf.apps.values()].filter((a) =>
    a.policies.some((p) => p.name === bypassPolicyName(INSTALL_ID)),
  );
}

async function bypassRow() {
  return env.DB.prepare("SELECT name, cf_id, deleted_at FROM resources WHERE id = ?1")
    .bind(bypassAppResourceId(INSTALL_ID))
    .first<{ name: string; cf_id: string | null; deleted_at: number | null }>();
}

async function seed(access?: unknown, resources: Array<{ kind: string; name: string }> = []) {
  await seedInstall({
    manifestJson: manifestWith(access),
    resources: [{ kind: "worker", name: "cut", cfId: "cut" }, ...resources],
  });
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await createDb(env.DB)
    .insert(user)
    .values({ id: "u1", name: "Owner", email: "owner@example.com", role: "admin" });
});

describe("bypass destinations", () => {
  it("covers workers.dev while it is on, each custom domain, and a wildcard base with every name under it", () => {
    const hosts = bypassHosts({
      workerName: "cut",
      subdomain: "acme",
      workersDev: true,
      customDomains: ["Links.Example.com"],
      wildcardBases: ["t.example.com"],
    });
    expect(hosts).toEqual([
      "cut.acme.workers.dev",
      "links.example.com",
      "t.example.com",
      "*.t.example.com",
    ]);
    expect(
      bypassHosts({
        workerName: "cut",
        subdomain: "acme",
        workersDev: false,
        customDomains: [],
        wildcardBases: [],
      }),
    ).toEqual([]);
    expect(bypassDestinations(["a.example.com", "*.t.example.com"], ["/s/*", "/hook"])).toEqual([
      { type: "public", uri: "a.example.com/s/*" },
      { type: "public", uri: "a.example.com/hook" },
      { type: "public", uri: "*.t.example.com/s/*" },
      { type: "public", uri: "*.t.example.com/hook" },
    ]);
  });

  it("reads the paths from the recorded manifest, and none from one without or unreadable", () => {
    expect(bypassPathsOfManifest(manifestWith({ bypass: ["/s/*"] }))).toEqual(["/s/*"]);
    expect(bypassPathsOfManifest(manifestWith({ mode: "required" }))).toEqual([]);
    expect(bypassPathsOfManifest(manifestWith({ bypass: ["/*"] }))).toEqual([]);
    expect(bypassPathsOfManifest("not json")).toEqual([]);
    expect(bypassPathsOfManifest(null)).toEqual([]);
  });
});

describe("protecting an install with public paths", () => {
  it("makes one bypass application for every path on every address, after the install's own", async () => {
    await seed({ bypass: ["/s/*", "/api/webhook"] }, [
      { kind: "domain", name: "links.example.com" },
    ]);
    const { cf, deps } = setup();
    const result = await protectInstall(deps, { installId: INSTALL_ID });
    expect(result.bypassProblem).toBeNull();
    expect(result.bypass?.outcome).toBe("created");
    const [bypass] = bypassApps(cf);
    expect(bypass).toMatchObject({
      name: "Appflare: Cut (cut) public paths",
      app_launcher_visible: false,
      destinations: [
        { type: "public", uri: `${HOST}/s/*` },
        { type: "public", uri: `${HOST}/api/webhook` },
        { type: "public", uri: "links.example.com/s/*" },
        { type: "public", uri: "links.example.com/api/webhook" },
      ],
    });
    expect(bypass?.policies).toEqual([
      expect.objectContaining({ name: bypassPolicyName(INSTALL_ID), decision: "bypass" }),
    ]);
    const inline = [...cf.appPolicies.values()].find((p) => p.appId === bypass?.id);
    expect(inline?.include).toEqual([{ everyone: {} }]);
    // The install's application was written first.
    const creates = cf.keys().filter((k) => k === "POST /access/apps");
    expect(creates).toHaveLength(2);
    const firstApp = cf.calls.find(
      (c) => c.key.endsWith("/access/apps") && c.key.startsWith("POST"),
    );
    expect((firstApp?.body as { name?: string } | undefined)?.name).toBe("Appflare: Cut (cut)");
    expect(await bypassRow()).toMatchObject({ cf_id: bypass?.id, deleted_at: null });
  });

  it("makes none for an entry without public paths, and costs no call to keep it so", async () => {
    await seed({ mode: "recommended" });
    const { cf, deps } = setup();
    const result = await protectInstall(deps, { installId: INSTALL_ID });
    expect(result.bypass?.outcome).toBe("none");
    expect(bypassApps(cf)).toHaveLength(0);
    const before = cf.calls.length;
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toBe("unchanged");
    expect(cf.calls.slice(before)).toEqual([]);
  });

  it("protecting again does not take its own public paths for another application's", async () => {
    await seed({ bypass: ["/s/*"] });
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const again = await protectInstall(deps, { installId: INSTALL_ID });
    expect(again.outcome).toBe("unchanged");
    expect(again.bypass?.outcome).toBe("unchanged");
    expect(bypassApps(cf)).toHaveLength(1);
  });

  it("finds a bypass application whose creation was not recorded, by its policy's name", async () => {
    await seed({ bypass: ["/s/*"] });
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await env.DB.prepare("DELETE FROM resources WHERE id = ?1")
      .bind(bypassAppResourceId(INSTALL_ID))
      .run();
    const again = await protectInstall(deps, { installId: INSTALL_ID });
    expect(again.bypass?.outcome).toBe("adopted");
    expect(bypassApps(cf)).toHaveLength(1);
    expect((await bypassRow())?.cf_id).toBe(bypassApps(cf)[0]?.id);
  });

  it("leaves the paths protected, never the app unprotected, when there are too many destinations", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `/p${i}`);
    const domains = Array.from({ length: 5 }, (_, i) => ({
      kind: "domain",
      name: `d${i}.example.com`,
    }));
    await seed({ bypass: paths }, domains);
    const { cf, deps } = setup();
    const result = await protectInstall(deps, { installId: INSTALL_ID });
    expect(result.bypassProblem).toBe(BYPASS_MESSAGES.tooMany(60));
    expect(60).toBeGreaterThan(MAX_ACCESS_APP_DESTINATIONS);
    expect(bypassApps(cf)).toHaveLength(0);
    expect(await readInstallProtection(env.DB, INSTALL_ID)).not.toBeNull();
  });
});

describe("keeping public paths in step", () => {
  it("follows a custom domain added and workers.dev turned off", async () => {
    await seed({ bypass: ["/s/*"] });
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:domain:new', ?1, 'domain', NULL, 'new.example.com', 'dom-2', 2)`,
    )
      .bind(INSTALL_ID)
      .run();
    await env.DB.prepare("UPDATE installs SET workers_dev_enabled = 0 WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    // The install's own application covers the domain by its Worker: unchanged.
    expect(await syncInstallAccessDestinations(deps, INSTALL_ID)).toBe("unchanged");
    expect(bypassApps(cf)[0]?.destinations).toEqual([
      { type: "public", uri: "new.example.com/s/*" },
    ]);
  });

  it("follows a wildcard domain with its base and every name under it", async () => {
    await seed({ bypass: ["/open/*"] }, [{ kind: "wildcard_domain", name: "t.example.com" }]);
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    expect(bypassApps(cf)[0]?.destinations).toEqual([
      { type: "public", uri: `${HOST}/open/*` },
      { type: "public", uri: "t.example.com/open/*" },
      { type: "public", uri: "*.t.example.com/open/*" },
    ]);
  });

  it("deletes the bypass application when the app has no address left for it", async () => {
    await seed({ bypass: ["/s/*"] });
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await env.DB.prepare("UPDATE installs SET workers_dev_enabled = 0 WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    await syncInstallAccessDestinations(deps, INSTALL_ID);
    expect(bypassApps(cf)).toHaveLength(0);
    expect((await bypassRow())?.deleted_at).not.toBeNull();
  });
});

describe("taking protection off", () => {
  it("deletes the public paths first, then the install's application and token", async () => {
    await seed({ bypass: ["/s/*"] });
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const [bypass] = bypassApps(cf);
    const protection = await readInstallProtection(env.DB, INSTALL_ID);
    const before = cf.calls.length;
    const removed = await unprotectInstall(deps, INSTALL_ID);
    expect(removed.removed).toBe(true);
    const deletes = cf.calls
      .slice(before)
      .map((c) => c.key)
      .filter((k) => k.startsWith("DELETE"));
    expect(deletes[0]).toContain(`/access/apps/${bypass?.id}`);
    expect(deletes[1]).toContain(`/access/apps/${protection?.accessAppId}`);
    expect(cf.apps.size).toBe(0);
    expect((await bypassRow())?.deleted_at).not.toBeNull();
  });

  it("finds an unrecorded bypass application by name only when the entry lists public paths", async () => {
    await seed({ mode: "recommended" });
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const before = cf.calls.length;
    await unprotectInstall(deps, INSTALL_ID);
    // The install's application is recorded; no list is needed to find anything.
    expect(cf.keys().slice(before)).not.toContain("GET /access/apps");
    expect(cf.apps.size).toBe(0);
  });
});

describe("accessAddressSync", () => {
  it("asks for no Cloudflare client for an app Appflare does not protect", async () => {
    await seed({ bypass: ["/s/*"] });
    let asked = 0;
    await accessAddressSync(env.DB, async () => {
      asked += 1;
      throw new Error("no client wanted");
    })(INSTALL_ID);
    expect(asked).toBe(0);
  });

  it("brings the public paths in step, and never throws when it cannot", async () => {
    await seed({ bypass: ["/s/*"] });
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:domain:new', ?1, 'domain', NULL, 'new.example.com', 'dom-2', 2)`,
    )
      .bind(INSTALL_ID)
      .run();
    await accessAddressSync(env.DB, async () => cf.client)(INSTALL_ID);
    expect(bypassApps(cf)[0]?.destinations).toContainEqual({
      type: "public",
      uri: "new.example.com/s/*",
    });
    // Another Access change holds the lock: the sync gives up quietly.
    await withAccessLock(env.DB, () =>
      accessAddressSync(env.DB, async () => cf.client)(INSTALL_ID),
    );
  });
});

describe("public paths ahead of a change", () => {
  it("leave a hostname, workers.dev, or paths before the change, from the records after", async () => {
    await seed({ bypass: ["/s/*", "/hook"] }, [{ kind: "domain", name: "links.example.com" }]);
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    const uris = () =>
      (bypassApps(cf)[0]?.destinations as Array<{ uri: string }> | undefined)?.map((d) => d.uri);
    await syncInstallAccessDestinations(deps, INSTALL_ID, {
      change: { leavingHosts: ["Links.Example.com"] },
    });
    expect(uris()).toEqual([`${HOST}/s/*`, `${HOST}/hook`]);
    await syncInstallAccessDestinations(deps, INSTALL_ID, { change: { workersDev: false } });
    expect(uris()).toEqual(["links.example.com/s/*", "links.example.com/hook"]);
    await syncInstallAccessDestinations(deps, INSTALL_ID, { change: { paths: ["/hook"] } });
    expect(uris()).toEqual([`${HOST}/hook`, "links.example.com/hook"]);
    await syncInstallAccessDestinations(deps, INSTALL_ID);
    expect(uris()).toHaveLength(4);
  });
});

/** Records a later revision of the fixture's release with these public paths. */
async function recordLaterRevision(
  f: Awaited<ReturnType<typeof buildArtifactFixture>>,
  revision: number,
  bypass: string[],
) {
  const later = { ...f.revised?.catalog, revision, access: { bypass } } as CatalogManifest;
  const text = JSON.stringify(later);
  const bytes = new TextEncoder().encode(text);
  await recordCatalogRevision(
    createDb(env.DB),
    f.digest,
    {
      catalog: later,
      text,
      file: {
        url: REVISED_URL,
        sha256: await sha256Hex(bytes),
        keyId: f.manifest.keyId,
        signature: await f.signBytes(bytes),
      },
    },
    NOW,
    f.manifest.catalog,
  );
}

describe("public paths from a revision of the release", () => {
  /** A protected install of a release with public path `/s/*`, whose revisions change it. */
  async function revisedWorld(revision: { access: { bypass: string[] } }) {
    const f = await buildArtifactFixture({ catalog: { access: { bypass: ["/s/*"] } }, revision });
    await seedInstall({
      manifestJson: new TextDecoder().decode(f.manifestBytes),
      resources: [{ kind: "worker", name: "cut", cfId: "cut" }],
    });
    await setInstallRelease(INSTALL_ID, f);
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    expect(bypassApps(cf)[0]?.destinations).toEqual([{ type: "public", uri: `${HOST}/s/*` }]);
    await recordFixtureRevision(f, NOW);
    // Marked for the cron, which brings the public paths in step.
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.syncFailedAt).toEqual(NOW);
    await resyncInstallAccessIfFailed({ db: env.DB, client: async () => cf.client });
    return { f, cf, deps };
  }

  it("does not make a path a revision adds public until an admin makes it public", async () => {
    const { cf } = await revisedWorld({ access: { bypass: ["/s/*", "/x/*"] } });
    expect(bypassApps(cf)[0]?.destinations).toEqual([{ type: "public", uri: `${HOST}/s/*` }]);
    expect(await readInstallAccessView(env.DB, INSTALL_ID)).toMatchObject({
      publicPaths: ["/s/*"],
      pendingPublicPaths: ["/x/*"],
    });
    const made = await makePublicPathsCore(
      { db: env.DB, client: async () => cf.client, now: () => NOW },
      INSTALL_ID,
      ["/x/*"],
    );
    expect(made).toEqual({ problem: null, accepted: ["/s/*", "/x/*"], pending: [] });
    expect(bypassApps(cf)[0]?.destinations).toEqual([
      { type: "public", uri: `${HOST}/s/*` },
      { type: "public", uri: `${HOST}/x/*` },
    ]);
    expect((await readInstallAccessView(env.DB, INSTALL_ID))?.pendingPublicPaths).toEqual([]);
  });

  it("accepts only the paths the card showed, not one a revision added after the page loaded", async () => {
    const { f, cf } = await revisedWorld({ access: { bypass: ["/s/*", "/x/*"] } });
    // The card shows /x/* waiting; meanwhile the catalog adds /y/*.
    const shown = (await readInstallAccessView(env.DB, INSTALL_ID))?.pendingPublicPaths ?? [];
    expect(shown).toEqual(["/x/*"]);
    await recordLaterRevision(f, 3, ["/s/*", "/x/*", "/y/*"]);
    const made = await makePublicPathsCore(
      { db: env.DB, client: async () => cf.client, now: () => NOW },
      INSTALL_ID,
      // A path the entry no longer lists is not accepted either.
      [...shown, "/gone/*"],
    );
    expect(made).toEqual({ problem: null, accepted: ["/s/*", "/x/*"], pending: ["/y/*"] });
    expect(bypassApps(cf)[0]?.destinations).toEqual([
      { type: "public", uri: `${HOST}/s/*` },
      { type: "public", uri: `${HOST}/x/*` },
    ]);
    expect((await readInstallAccessView(env.DB, INSTALL_ID))?.pendingPublicPaths).toEqual(["/y/*"]);
  });

  it("takes a path a revision removes off on its own, and asks again if a later one lists it", async () => {
    const { f, cf } = await revisedWorld({ access: { bypass: ["/x/*"] } });
    // /s/* is gone; /x/* waits for an admin.
    expect(bypassApps(cf)).toHaveLength(0);
    expect(await readAcceptedBypass(createDb(env.DB), INSTALL_ID)).toEqual([]);
    // A later revision lists /s/* again: it was dropped, so it is not accepted any more.
    await recordLaterRevision(f, 3, ["/s/*"]);
    await resyncInstallAccessIfFailed({ db: env.DB, client: async () => cf.client });
    expect(bypassApps(cf)).toHaveLength(0);
    expect((await readInstallAccessView(env.DB, INSTALL_ID))?.pendingPublicPaths).toEqual(["/s/*"]);
  });

  it("refuses Make public for an app that is not protected", async () => {
    await seed({ bypass: ["/s/*"] });
    const { cf } = setup();
    await expect(
      makePublicPathsCore({ db: env.DB, client: async () => cf.client }, INSTALL_ID, ["/s/*"]),
    ).rejects.toThrow("not protected");
  });
});

describe("a failed sync outside a job", () => {
  it("is recorded on the install, retried by the cron, and cleared once it succeeds", async () => {
    await seed({ bypass: ["/s/*"] });
    const { cf, deps } = setup();
    await protectInstall(deps, { installId: INSTALL_ID });
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:domain:new', ?1, 'domain', NULL, 'new.example.com', 'dom-2', 2)`,
    )
      .bind(INSTALL_ID)
      .run();
    cf.forbidden.add("PUT /accounts/*");
    await accessAddressSync(
      env.DB,
      async () => cf.client,
      () => NOW,
    )(INSTALL_ID);
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.syncFailedAt).toEqual(NOW);

    // The cron, while Cloudflare still refuses: still recorded.
    expect(
      await resyncInstallAccessIfFailed({ db: env.DB, client: async () => cf.client }),
    ).toEqual([expect.objectContaining({ installId: INSTALL_ID, outcome: "failed" })]);
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.syncFailedAt).toEqual(NOW);

    cf.forbidden.clear();
    expect(
      await resyncInstallAccessIfFailed({ db: env.DB, client: async () => cf.client }),
    ).toEqual([{ installId: INSTALL_ID, outcome: "unchanged" }]);
    expect((await readInstallProtection(env.DB, INSTALL_ID))?.syncFailedAt).toBeNull();
    expect(bypassApps(cf)[0]?.destinations).toContainEqual({
      type: "public",
      uri: "new.example.com/s/*",
    });
    // Nothing failed: a D1 read only.
    let asked = 0;
    expect(
      await resyncInstallAccessIfFailed({
        db: env.DB,
        client: async () => {
          asked += 1;
          return cf.client;
        },
      }),
    ).toEqual([]);
    expect(asked).toBe(0);
  });
});
