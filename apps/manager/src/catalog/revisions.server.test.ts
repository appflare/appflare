import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import type { CatalogManifest } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { sha256Hex } from "../jobs/install/artifact";
import { type ArtifactFixture, buildArtifactFixture, REVISED_URL } from "../test/artifact-fixture";
import { fakeKv } from "../test/fake-kv";
import {
  catalogManifestCacheKey,
  getAppManifest,
  getCatalogManifest,
  readCachedCatalogManifest,
  refreshInstalledRevision,
} from "./app-manifest.server";
import {
  effectiveManifest,
  readCatalogRevision,
  recordCatalogRevision,
  verifyRevisedCatalog,
} from "./revisions.server";

const homePage = {
  name: "HOME_PAGE",
  label: "Home page",
  required: false,
  type: "select" as const,
  options: [
    { value: "default", label: "Show the landing page" },
    { value: "404", label: "Return an empty 404 response" },
    { value: "admin", label: "Redirect to /admin" },
  ],
  default: "default",
};

/** A fetch over the fixture that counts requests per URL. */
function serving(fixture: ArtifactFixture) {
  const hits: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    hits.push(url);
    return fixture.serve(url, init) ?? new Response("not found", { status: 404 });
  };
  return { fetch, hits };
}

const enc = new TextEncoder();
const orm = () => createDb(env.DB);

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("verifyRevisedCatalog", () => {
  it("accepts the listed bytes of a form-only revision of this release", async () => {
    const f = await buildArtifactFixture({ revision: { vars: [homePage] } });
    const file = f.index.catalogManifest;
    if (file === undefined || f.revised === null) throw new Error("no revision");
    const catalog = await verifyRevisedCatalog(f.revised.bytes, {
      file,
      artifact: f.manifest,
      revision: 2,
      keys: f.keys,
    });
    expect(catalog.vars).toEqual([homePage]);
  });

  it("refuses an unsigned, badly signed, or otherwise keyed revision before reading it", async () => {
    const f = await buildArtifactFixture({ revision: { vars: [homePage] } });
    const file = f.index.catalogManifest;
    if (file === undefined || f.revised === null) throw new Error("no revision");
    const bytes = f.revised.bytes;
    const verify = (over: Partial<typeof file>, keys = f.keys) =>
      verifyRevisedCatalog(bytes, { file: { ...file, ...over }, artifact: f.manifest, keys });
    // Signed by another key under the release's key id (the embedded keys by default).
    await expect(verifyRevisedCatalog(bytes, { file, artifact: f.manifest })).rejects.toThrow(
      /no trusted signing key matches keyId "test-key"/,
    );
    await expect(verify({ signature: "" })).rejects.toThrow(/signature does not verify/);
    const other = await buildArtifactFixture();
    await expect(verify({ signature: await other.signBytes(bytes) })).rejects.toThrow(
      /signature does not verify with keyId "test-key"/,
    );
    await expect(verify({ keyId: "catalog-2026-09" })).rejects.toThrow(
      /signed with key "catalog-2026-09", but cut 1\.0\.0 was released with key "test-key"/,
    );
  });

  it("refuses other bytes, another app, another revision, and changes to the build", async () => {
    const f = await buildArtifactFixture();
    const check = async (catalog: CatalogManifest, revision?: number) => {
      const bytes = enc.encode(JSON.stringify(catalog));
      return verifyRevisedCatalog(bytes, {
        file: {
          url: REVISED_URL,
          sha256: await sha256Hex(bytes),
          keyId: f.manifest.keyId,
          signature: await f.signBytes(bytes),
        },
        artifact: f.manifest,
        keys: f.keys,
        ...(revision === undefined ? {} : { revision }),
      });
    };
    const base = { ...f.manifest.catalog, revision: 2 };
    await expect(
      verifyRevisedCatalog(enc.encode("{}"), {
        file: { url: REVISED_URL, sha256: "0".repeat(64), keyId: "test-key", signature: "x" },
        artifact: f.manifest,
      }),
    ).rejects.toThrow(/does not match the catalog index/);
    await expect(check({ ...base, slug: "other" })).rejects.toThrow(/is for "other", not "cut"/);
    await expect(check(base, 3)).rejects.toThrow(
      /is revision 2, the catalog index lists revision 3/,
    );
    await expect(check({ ...base, revision: 1 })).rejects.toThrow(
      /revision 1 is not above revision 1/,
    );
    await expect(check({ ...base, plan: "paid" })).rejects.toThrow(
      /cannot replace the one cut 1\.0\.0 was built with: it changes plan/,
    );
  });
});

describe("catalog_revisions", () => {
  const catalogOf = async (revision: number, summary = "Revised.") => {
    const f = await buildArtifactFixture();
    const catalog = { ...f.manifest.catalog, summary, revision };
    const text = JSON.stringify(catalog);
    const file = {
      url: REVISED_URL,
      sha256: await sha256Hex(enc.encode(text)),
      keyId: f.manifest.keyId,
      signature: await f.signBytes(enc.encode(text)),
    };
    return { f, catalog, text, file };
  };

  it("keeps the newest revision per release with its signature, writing only on a change", async () => {
    const two = await catalogOf(2);
    const now = new Date(1_000);
    expect(await recordCatalogRevision(orm(), "d".repeat(64), two, now)).toBe(true);
    expect(await recordCatalogRevision(orm(), "d".repeat(64), two, now)).toBe(false);
    const one = await catalogOf(1, "Older.");
    expect(await recordCatalogRevision(orm(), "d".repeat(64), one, now)).toBe(false);
    const three = await catalogOf(3);
    expect(await recordCatalogRevision(orm(), "d".repeat(64), three, now)).toBe(true);
    const recorded = await readCatalogRevision(orm(), "d".repeat(64));
    expect(recorded).toMatchObject({
      revision: 3,
      sha256: three.file.sha256,
      keyId: "test-key",
      signature: three.file.signature,
      text: three.text,
    });
    expect(await readCatalogRevision(orm(), "e".repeat(64))).toBeNull();
  });

  it("refuses other bytes under a revision it already holds", async () => {
    const two = await catalogOf(2);
    await recordCatalogRevision(orm(), "d".repeat(64), two, new Date());
    const twoAgain = await catalogOf(2, "Same revision, new bytes.");
    await expect(
      recordCatalogRevision(orm(), "d".repeat(64), twoAgain, new Date()),
    ).rejects.toThrow(/revision 2 of this release is already recorded with other bytes/);
    expect((await readCatalogRevision(orm(), "d".repeat(64)))?.sha256).toBe(two.file.sha256);
  });

  it("gives installs of the release the recorded form, and leaves others alone", async () => {
    const { f, catalog, text, file } = await catalogOf(2);
    expect(await effectiveManifest(orm(), f.manifest, f.digest)).toBe(f.manifest);
    await recordCatalogRevision(orm(), f.digest, { catalog, text, file }, new Date());
    const effective = await effectiveManifest(orm(), f.manifest, f.digest);
    expect(effective.catalog.summary).toBe("Revised.");
    expect(effective.worker).toEqual(f.manifest.worker);
    expect(await effectiveManifest(orm(), f.manifest, null)).toBe(f.manifest);
    // A row that does not fit this manifest (another app's) is never applied.
    const other = { ...f.manifest, app: "other", catalog: { ...f.manifest.catalog, slug: "x" } };
    expect(await effectiveManifest(orm(), other, f.digest)).toBe(other);
  });
});

describe("getAppManifest with a revision", () => {
  it("reads the form from the revision, caches it by digest, and records it for the release", async () => {
    const f = await buildArtifactFixture({ revision: { vars: [homePage] } });
    const { kv, store } = fakeKv();
    const { fetch, hits } = serving(f);
    const read = await getAppManifest({ KV: kv, DB: env.DB }, f.index, {
      fetch,
      signingKeys: f.keys,
    });
    if (!read.ok) throw new Error(read.error);
    expect(read.manifest.catalog.vars).toEqual([homePage]);
    expect(read.manifest.worker).toEqual(f.manifest.worker);
    const sha = f.index.catalogManifest?.sha256 ?? "";
    expect(store.has(catalogManifestCacheKey(sha))).toBe(true);
    expect((await readCatalogRevision(orm(), f.digest))?.revision).toBe(2);

    // Cached: nothing is fetched again, and the catalog list reads it too.
    hits.length = 0;
    const again = await getCatalogManifest({ KV: kv, DB: env.DB }, f.index, {
      fetch,
      signingKeys: f.keys,
    });
    expect(again.ok && again.catalog.vars).toEqual([homePage]);
    expect(hits).toEqual([]);
    const cached = await readCachedCatalogManifest({ KV: kv }, f.index);
    expect(cached?.catalog.vars).toEqual([homePage]);
  });

  it("lists the signed form until the revision is cached", async () => {
    const f = await buildArtifactFixture({ revision: { vars: [homePage] } });
    const { kv } = fakeKv();
    const signed = { ...f.index, catalogManifest: undefined };
    const { fetch } = serving(f);
    await getAppManifest({ KV: kv }, signed, { fetch, signingKeys: f.keys });
    expect(await readCachedCatalogManifest({ KV: kv }, f.index)).toBeNull();
  });

  it("uses a higher revision recorded for the release over the one the index lists", async () => {
    const f = await buildArtifactFixture({ revision: { vars: [homePage] } });
    const { kv } = fakeKv();
    const { fetch, hits } = serving(f);
    const three = { ...f.manifest.catalog, summary: "Revision three.", revision: 3 };
    const text = JSON.stringify(three);
    await recordCatalogRevision(
      orm(),
      f.digest,
      {
        text,
        catalog: three,
        file: {
          url: REVISED_URL,
          sha256: await sha256Hex(enc.encode(text)),
          keyId: "test-key",
          signature: await f.signBytes(enc.encode(text)),
        },
      },
      new Date(),
    );
    for (const app of [f.index, { ...f.index, catalogManifest: undefined, revision: undefined }]) {
      const read = await getAppManifest({ KV: kv, DB: env.DB }, app, {
        fetch,
        signingKeys: f.keys,
      });
      expect(read.ok && read.manifest.catalog.summary).toBe("Revision three.");
    }
    expect(hits.filter((u) => u === REVISED_URL)).toEqual([]);
  });

  it("refuses a revision that does not verify, and logs it, rather than use the older form", async () => {
    const f = await buildArtifactFixture({ revision: { vars: [homePage] } });
    const { kv } = fakeKv();
    const { fetch } = serving(f);
    const listed = f.index.catalogManifest;
    if (listed === undefined) throw new Error("no revision");
    const unsigned = { ...f.index, catalogManifest: { ...listed, signature: "AAAA" } };
    const read = await getAppManifest({ KV: kv, DB: env.DB }, unsigned, {
      fetch,
      signingKeys: f.keys,
    });
    expect(!read.ok && read.error).toMatch(
      /Could not load revision 2 of the catalog manifest for cut 1\.0\.0: .*signature does not verify/,
    );
    expect(await readCatalogRevision(orm(), f.digest)).toBeNull();
  });

  it("fails, naming the revision, when its bytes do not match", async () => {
    const f = await buildArtifactFixture({ revision: { vars: [homePage] } });
    const { kv } = fakeKv();
    const { fetch } = serving(f);
    const listed = f.index.catalogManifest;
    if (listed === undefined) throw new Error("no revision");
    const wrong = {
      ...f.index,
      catalogManifest: { ...listed, sha256: "0".repeat(64) },
    };
    const read = await getAppManifest({ KV: kv, DB: env.DB }, wrong, {
      fetch,
      signingKeys: f.keys,
    });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toMatch(
      /Could not load revision 2 of the catalog manifest for cut 1\.0\.0: .*does not match/,
    );
    expect(await readCatalogRevision(orm(), f.digest)).toBeNull();
  });
});

describe("refreshInstalledRevision", () => {
  it("records a revision of the installed release once, and nothing for another release", async () => {
    const f = await buildArtifactFixture({ revision: { vars: [homePage] } });
    const { kv } = fakeKv();
    const { fetch, hits } = serving(f);
    const envs = { KV: kv, DB: env.DB };
    const opts = { fetch, signingKeys: f.keys };
    await refreshInstalledRevision(
      envs,
      { catalog_version: "0.9.0", artifact_digest: f.digest },
      f.index,
      opts,
    );
    await refreshInstalledRevision(
      envs,
      { catalog_version: "1.0.0", artifact_digest: "e".repeat(64) },
      f.index,
      opts,
    );
    expect(hits).toEqual([]);
    expect(await readCatalogRevision(orm(), f.digest)).toBeNull();

    const installed = { catalog_version: "1.0.0", artifact_digest: f.digest };
    await refreshInstalledRevision(envs, installed, f.index, opts);
    expect((await readCatalogRevision(orm(), f.digest))?.catalog.vars).toEqual([homePage]);
    hits.length = 0;
    await refreshInstalledRevision(envs, installed, f.index, opts);
    expect(hits).toEqual([]);
  });
});
