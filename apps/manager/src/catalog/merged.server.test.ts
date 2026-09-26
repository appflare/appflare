import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { formatPublicKey, type IndexApp } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { readCandidateRows, updateCandidates } from "../auto-update/cron.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { type ArtifactFixture, buildArtifactFixture } from "../test/artifact-fixture";
import { getAppManifest, manifestCacheKey } from "./app-manifest.server";
import { addCatalogCore, setCatalogEnabledCore } from "./catalog-admin.server";
import { CatalogTrustError, catalogTrust, OFFICIAL_TRUST } from "./catalogs.server";
import { CATALOG_INDEX_KEY } from "./index.server";
import {
  catalogLookup,
  findCatalogApp,
  lookupOf,
  readCachedListing,
  readEnabledCatalogs,
} from "./merged.server";
import { refreshEnabledCatalogs } from "./refresh.server";

const ACME_URL = "https://acme.test/index.json";
const OFFICIAL_URL = "https://catalog.test/index.json";

function indexOf(apps: IndexApp[], extra: Record<string, unknown> = {}) {
  return { generatedAt: "2026-09-26T00:00:00.000Z", apps, featured: [], ...extra };
}

/**
 * Two catalogs listing the same slug: the official one serves `official`'s
 * release, Acme serves `acme`'s. Both releases live at the fixture URLs,
 * so each test serves one of them.
 */
function world(release: ArtifactFixture, indexes: Record<string, unknown>) {
  const hits: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    hits.push(url);
    const index = indexes[url];
    if (index !== undefined) return Response.json(index);
    return release.serve(url, init) ?? new Response("not found", { status: 404 });
  };
  return { fetch, hits };
}

const mergedEnv = () => ({ KV: env.KV, DB: env.DB, CATALOG_INDEX_URL: OFFICIAL_URL });

async function addAcme(release: ArtifactFixture) {
  const key = release.keys[0];
  if (key === undefined) throw new Error("fixture without a key");
  const w = world(release, { [ACME_URL]: indexOf([release.index]) });
  await addCatalogCore(
    { db: env.DB, kv: env.KV, fetch: w.fetch, officialIndexUrl: OFFICIAL_URL },
    { indexUrl: ACME_URL, publicKeys: formatPublicKey(key), label: "Acme", colour: "purple" },
  );
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("per-catalog verification", () => {
  it("verifies a custom catalog's release with its pinned key and never with the built-in keys", async () => {
    const release = await buildArtifactFixture({ keyId: "acme-2026-09" });
    await addAcme(release);
    const found = await findCatalogApp(mergedEnv(), "acme:cut");
    if (!found.ok || found.listed === null) throw new Error("acme:cut not found");
    expect(found.listed.trust).toEqual({ catalogId: "acme", signingKeys: release.keys });

    const w = world(release, {});
    const read = await getAppManifest(env, found.listed.app, {
      fetch: w.fetch,
      ...found.listed.trust,
    });
    expect(read.ok).toBe(true);
    // Cached for Acme only: what Acme's key verified is never read as the official catalog's.
    expect(await env.KV.get(manifestCacheKey(release.digest, "acme"))).not.toBeNull();
    expect(await env.KV.get(manifestCacheKey(release.digest))).toBeNull();

    // The same release through the official catalog's trust (the built-in keys) is refused.
    const official = await getAppManifest(env, found.listed.app, {
      fetch: w.fetch,
      ...OFFICIAL_TRUST,
    });
    expect(official).toEqual({
      ok: false,
      error:
        'Could not load the signed manifest for cut 1.0.0: no trusted signing key matches keyId "acme-2026-09"',
    });
  });

  it("refuses a custom catalog's release signed with another key, even under its key id", async () => {
    const pinned = await buildArtifactFixture({ keyId: "acme-2026-09" });
    const forged = await buildArtifactFixture({ keyId: "acme-2026-09" });
    await addAcme(pinned);
    const trust = await catalogTrust(createDb(env.DB), "acme");
    const read = await getAppManifest(env, forged.index, {
      fetch: world(forged, {}).fetch,
      ...trust,
    });
    expect(read).toEqual({
      ok: false,
      error:
        'Could not load the signed manifest for cut 1.0.0: manifest signature does not verify with keyId "acme-2026-09"',
    });
  });

  it("gives jobs the official keys for the official catalog and refuses a removed catalog", async () => {
    expect(await catalogTrust(createDb(env.DB), null)).toEqual(OFFICIAL_TRUST);
    expect(await catalogTrust(createDb(env.DB), "official")).toEqual(OFFICIAL_TRUST);
    await expect(catalogTrust(createDb(env.DB), "gone")).rejects.toThrow(CatalogTrustError);
  });
});

describe("the merged catalog", () => {
  it("keeps the same slug in two catalogs apart, and looks installs up in their own catalog", async () => {
    const acme = await buildArtifactFixture({ keyId: "acme-2026-09", version: "2.0.0" });
    const official = await buildArtifactFixture({ version: "1.0.0" });
    await addAcme(acme);
    await env.KV.put(CATALOG_INDEX_KEY, JSON.stringify(indexOf([official.index])));

    const lookup = await catalogLookup(mergedEnv(), { refreshOnMiss: false });
    expect([...lookup.keys()].sort()).toEqual(["acme:cut", "cut"]);
    expect(lookup.get("cut")?.app.version).toBe("1.0.0");
    expect(lookup.get("acme:cut")?.app.version).toBe("2.0.0");
    expect(lookup.get("acme:cut")?.source).toEqual({
      id: "acme",
      label: "Acme",
      colour: "purple",
      official: false,
    });
    // A custom catalog's apps carry no images.
    expect(lookup.get("acme:cut")?.app.media).toBeUndefined();

    expect((await readCachedListing(mergedEnv(), "acme", "cut"))?.app.version).toBe("2.0.0");
    expect((await readCachedListing(mergedEnv(), null, "cut"))?.app.version).toBe("1.0.0");
    expect((await readCachedListing(mergedEnv(), "official", "cut"))?.app.version).toBe("1.0.0");

    // Turned off: its apps are not listed and its installs find no update.
    await setCatalogEnabledCore({ db: env.DB, kv: env.KV }, { id: "acme", enabled: false });
    expect([...(await catalogLookup(mergedEnv(), { refreshOnMiss: false })).keys()]).toEqual([
      "cut",
    ]);
    expect(await readCachedListing(mergedEnv(), "acme", "cut")).toBeNull();
    expect(await findCatalogApp(mergedEnv(), "acme:cut")).toEqual({ ok: true, listed: null });
  });

  it("refreshes every enabled catalog once, and skips one that is off", async () => {
    const acme = await buildArtifactFixture({ keyId: "acme-2026-09" });
    await addAcme(acme);
    const w = world(acme, {
      [ACME_URL]: indexOf([acme.index], { stats: "https://acme.test/stats.json" }),
      [OFFICIAL_URL]: indexOf([]),
    });
    const lines = await refreshEnabledCatalogs(mergedEnv(), { fetch: w.fetch });
    expect(lines).toEqual([
      { id: "official", ok: true, apps: 0 },
      { id: "acme", ok: true, apps: 1 },
    ]);
    // One request per catalog; a custom catalog's stats file is never fetched.
    expect(w.hits).toEqual([OFFICIAL_URL, ACME_URL]);

    await setCatalogEnabledCore({ db: env.DB, kv: env.KV }, { id: "official", enabled: false });
    w.hits.length = 0;
    expect(await refreshEnabledCatalogs(mergedEnv(), { fetch: w.fetch })).toEqual([
      { id: "acme", ok: true, apps: 1 },
    ]);
    expect(w.hits).toEqual([ACME_URL]);
  });
});

describe("update checks", () => {
  it("compare an install with its own catalog's version only", async () => {
    const official = await buildArtifactFixture({ version: "9.9.9" });
    const acme = await buildArtifactFixture({ keyId: "acme-2026-09", version: "2.0.0" });
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status,
         installed_at, updated_at, catalog_id)
       VALUES ('i-acme', 'cut', 'cut-acme', '1.0.0', 'x', 'installed', 1, 1, 'acme'),
              ('i-official', 'cut', 'cut', '1.0.0', 'x', 'installed', 2, 2, 'official')`,
    ).run();
    const acmeSource = { id: "acme", label: "Acme", colour: "blue" as const, official: false };
    const listed = new Map([
      ...lookupOf([official.index]),
      ...lookupOf([acme.index], acmeSource, { catalogId: "acme", signingKeys: acme.keys }),
    ]);
    const candidates = await updateCandidates(env.DB, await readCandidateRows(env.DB), listed);
    expect(Object.fromEntries(candidates.map((c) => [c.installId, c.latest?.version]))).toEqual({
      "i-acme": "2.0.0",
      "i-official": "9.9.9",
    });
    // Without its own catalog listed, the custom install is not updated from the official one.
    const officialOnly = await updateCandidates(
      env.DB,
      await readCandidateRows(env.DB),
      lookupOf([official.index]),
    );
    expect(officialOnly.find((c) => c.installId === "i-acme")?.latest).toBeNull();
  });
});

describe("one bad catalog", () => {
  /** env.KV, except that every read of Acme's cached index fails. */
  function brokenAcmeKv(): KVNamespace {
    const broken = (key: unknown) => typeof key === "string" && key.startsWith("catalog:acme:");
    return new Proxy(env.KV, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        if (prop !== "get" && prop !== "getWithMetadata") return value.bind(target);
        return (key: unknown, ...rest: unknown[]) => {
          if (broken(key)) return Promise.reject(new Error("KV is unavailable"));
          return (value as (...args: unknown[]) => unknown).call(target, key, ...rest);
        };
      },
    });
  }

  it("never aborts the cron's refresh of the others, and is recorded on its row", async () => {
    const acme = await buildArtifactFixture({ keyId: "acme-2026-09" });
    await addAcme(acme);
    const w = world(acme, { [ACME_URL]: indexOf([acme.index]), [OFFICIAL_URL]: indexOf([]) });
    const lines = await refreshEnabledCatalogs(
      { ...mergedEnv(), KV: brokenAcmeKv() },
      { fetch: w.fetch },
    );
    expect(lines).toEqual([
      { id: "official", ok: true, apps: 0 },
      { id: "acme", ok: false, error: "KV is unavailable" },
    ]);
    const row = await env.DB.prepare(
      "SELECT refresh_error FROM catalogs WHERE id = 'acme'",
    ).first();
    expect(row).toEqual({ refresh_error: "KV is unavailable" });
  });

  it("never takes the Catalog page's other catalogs down", async () => {
    const acme = await buildArtifactFixture({ keyId: "acme-2026-09" });
    const official = await buildArtifactFixture();
    await addAcme(acme);
    await env.KV.put(CATALOG_INDEX_KEY, JSON.stringify(indexOf([official.index])));
    const reads = await readEnabledCatalogs({ ...mergedEnv(), KV: brokenAcmeKv() });
    expect(reads.map((r) => [r.source.id, r.ok])).toEqual([
      ["official", true],
      ["acme", false],
    ]);
    expect(reads[1]).toMatchObject({ error: "Acme could not be read: KV is unavailable" });
  });

  it("with an index too large to read is refused, and the others refresh", async () => {
    const acme = await buildArtifactFixture({ keyId: "acme-2026-09" });
    await addAcme(acme);
    const huge: FetchLike = async (url) =>
      url === ACME_URL
        ? new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } })
        : Response.json(indexOf([]));
    const lines = await refreshEnabledCatalogs(mergedEnv(), { fetch: huge });
    expect(lines[0]).toEqual({ id: "official", ok: true, apps: 0 });
    expect(lines[1]).toMatchObject({ id: "acme", ok: false });
    expect(lines[1]?.ok === false && lines[1].error).toContain("is larger than 4 MiB");
  });
});
