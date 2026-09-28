import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { formatPublicKey, type IndexApp } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { type ArtifactFixture, buildArtifactFixture } from "../test/artifact-fixture";
import { addCatalogCore, setCatalogEnabledCore } from "./catalog-admin.server";
import { CATALOG_INDEX_KEY } from "./index.server";
import { findInstallLinkTarget } from "./install-intent.server";

const OFFICIAL_URL = "https://catalog.test/index.json";
const ACME_URL = "https://acme.test/index.json";

function indexOf(apps: IndexApp[]) {
  return { generatedAt: "2026-09-28T00:00:00.000Z", apps, featured: [] };
}

/**
 * The catalogs' sites: each index URL serves what `indexes` holds, and
 * `release` its artifact (adding a catalog reads one); every request is kept.
 */
function sites(indexes: Record<string, unknown>, release?: ArtifactFixture) {
  const hits: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    hits.push(url);
    const index = indexes[url];
    if (index !== undefined) return Response.json(index);
    return release?.serve(url, init) ?? new Response("not found", { status: 404 });
  };
  return { fetch, hits };
}

const ADMIN = { isAdmin: true };
const MEMBER = { isAdmin: false };

const catalogEnv = () => ({ KV: env.KV, DB: env.DB, CATALOG_INDEX_URL: OFFICIAL_URL });

/** Nothing an install link does may leave a job behind. */
async function jobCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("findInstallLinkTarget", () => {
  it("opens the app's page when the official catalog lists the slug, without fetching", async () => {
    const cut = await buildArtifactFixture();
    await env.KV.put(CATALOG_INDEX_KEY, JSON.stringify(indexOf([cut.index])));
    const s = sites({});
    expect(await findInstallLinkTarget(catalogEnv(), "cut", ADMIN, { fetch: s.fetch })).toEqual({
      found: true,
      key: "cut",
    });
    expect(s.hits).toEqual([]);
    expect(await jobCount()).toBe(0);
  });

  it("finds a slug only an added catalog lists, under that catalog's key", async () => {
    const acme = await buildArtifactFixture({ keyId: "acme-2026-09" });
    const key = acme.keys[0];
    if (key === undefined) throw new Error("fixture without a key");
    await env.KV.put(CATALOG_INDEX_KEY, JSON.stringify(indexOf([])));
    const s = sites({ [ACME_URL]: indexOf([acme.index]), [OFFICIAL_URL]: indexOf([]) }, acme);
    await addCatalogCore(
      { db: env.DB, kv: env.KV, fetch: s.fetch, officialIndexUrl: OFFICIAL_URL },
      { indexUrl: ACME_URL, publicKeys: formatPublicKey(key), label: "Acme", colour: "purple" },
    );
    expect(await findInstallLinkTarget(catalogEnv(), "cut", ADMIN, { fetch: s.fetch })).toEqual({
      found: true,
      key: "acme:cut",
    });
    expect(
      await findInstallLinkTarget(catalogEnv(), "acme:cut", ADMIN, { fetch: s.fetch }),
    ).toEqual({
      found: true,
      key: "acme:cut",
    });
  });

  it("fetches the catalogs once more before saying an app is not there", async () => {
    const cut = await buildArtifactFixture();
    await env.KV.put(CATALOG_INDEX_KEY, JSON.stringify(indexOf([])));
    // Published after the cached copy was taken.
    const s = sites({ [OFFICIAL_URL]: indexOf([cut.index]) });
    expect(await findInstallLinkTarget(catalogEnv(), "cut", ADMIN, { fetch: s.fetch })).toEqual({
      found: true,
      key: "cut",
    });
    expect(s.hits).toEqual([OFFICIAL_URL]);

    const missing = sites({ [OFFICIAL_URL]: indexOf([cut.index]) });
    expect(
      await findInstallLinkTarget(catalogEnv(), "nope", ADMIN, { fetch: missing.fetch }),
    ).toEqual({
      found: false,
      officialOff: false,
    });
    expect(missing.hits).toEqual([OFFICIAL_URL]);
    expect(await jobCount()).toBe(0);
  });

  it("answers a member from the cached catalogs alone, never fetching them again", async () => {
    const cut = await buildArtifactFixture();
    await env.KV.put(CATALOG_INDEX_KEY, JSON.stringify(indexOf([])));
    const s = sites({ [OFFICIAL_URL]: indexOf([cut.index]) });
    expect(await findInstallLinkTarget(catalogEnv(), "cut", MEMBER, { fetch: s.fetch })).toEqual({
      found: false,
      officialOff: false,
    });
    expect(s.hits).toEqual([]);

    await env.KV.put(CATALOG_INDEX_KEY, JSON.stringify(indexOf([cut.index])));
    expect(await findInstallLinkTarget(catalogEnv(), "cut", MEMBER, { fetch: s.fetch })).toEqual({
      found: true,
      key: "cut",
    });
    expect(s.hits).toEqual([]);
  });

  it("says so when the official catalog is turned off", async () => {
    const cut = await buildArtifactFixture();
    await env.KV.put(CATALOG_INDEX_KEY, JSON.stringify(indexOf([cut.index])));
    await setCatalogEnabledCore({ db: env.DB, kv: env.KV }, { id: "official", enabled: false });
    const s = sites({ [OFFICIAL_URL]: indexOf([cut.index]) });
    expect(await findInstallLinkTarget(catalogEnv(), "cut", ADMIN, { fetch: s.fetch })).toEqual({
      found: false,
      officialOff: true,
    });
    // A catalog that is off is never fetched.
    expect(s.hits).toEqual([]);
  });

  it("opens the app's page when its catalog cannot be read, so the page says why", async () => {
    const s = sites({});
    expect(await findInstallLinkTarget(catalogEnv(), "cut", ADMIN, { fetch: s.fetch })).toEqual({
      found: true,
      key: "cut",
    });
  });

  it("refuses a link that is not a slug before reading any catalog", async () => {
    const s = sites({});
    for (const raw of ["../settings", "Cut", "cut/x", "//evil.example", "javascript:alert(1)"]) {
      expect(
        await findInstallLinkTarget(catalogEnv(), raw, ADMIN, { fetch: s.fetch }),
        raw,
      ).toEqual({
        found: false,
        officialOff: false,
      });
    }
    expect(s.hits).toEqual([]);
    expect(await jobCount()).toBe(0);
  });
});
