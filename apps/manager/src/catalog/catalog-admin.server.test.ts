import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { formatPublicKey, type IndexApp, signingKeys } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { type ArtifactFixture, buildArtifactFixture } from "../test/artifact-fixture";
import {
  addCatalogCore,
  type CatalogAdminDeps,
  deleteCatalogCore,
  setCatalogEnabledCore,
  updateCatalogCore,
} from "./catalog-admin.server";
import { listCatalogRecords, readCatalogRecord } from "./catalogs.server";
import {
  customCatalogIndexKey,
  DEFAULT_CATALOG_INDEX_URL,
  readCachedCustomCatalogIndex,
} from "./index.server";
import { readEnabledCatalogs } from "./merged.server";

const INDEX_URL = "https://acme.test/catalog/index.json";
const KEY_ID = "acme-2026-09";
const NOW = new Date("2026-09-26T12:00:00.000Z");

function indexOf(apps: IndexApp[]) {
  return {
    generatedAt: "2026-09-26T00:00:00.000Z",
    apps,
    featured: [],
    stats: "https://acme.test/catalog/stats.json",
  };
}

/** Serves the catalog's index at {@link INDEX_URL} and the fixture's release; counts requests. */
function serving(fixture: ArtifactFixture, index: unknown = indexOf([fixture.index])) {
  const hits: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    hits.push(url);
    if (url === INDEX_URL) return Response.json(index, { headers: { etag: '"v1"' } });
    return fixture.serve(url, init) ?? new Response("not found", { status: 404 });
  };
  return { fetch, hits };
}

function deps(fetch: FetchLike): CatalogAdminDeps {
  return { db: env.DB, kv: env.KV, fetch, now: () => NOW };
}

function pasted(fixture: ArtifactFixture, keyId = KEY_ID): string {
  const key = fixture.keys[0];
  if (key === undefined) throw new Error("fixture without a key");
  return formatPublicKey({ keyId, publicKeyBase64: key.publicKeyBase64 });
}

function input(fixture: ArtifactFixture, over: Record<string, string> = {}) {
  return {
    indexUrl: INDEX_URL,
    publicKeys: pasted(fixture),
    label: "Acme",
    colour: "blue" as const,
    ...over,
  };
}

async function customRows() {
  return (await listCatalogRecords(createDb(env.DB))).filter((r) => r.kind === "custom");
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("the catalogs table", () => {
  it("is seeded with the official catalog, on", async () => {
    const [official, ...rest] = await listCatalogRecords(createDb(env.DB));
    expect(rest).toEqual([]);
    expect(official).toMatchObject({
      id: "official",
      kind: "official",
      label: "Official",
      indexUrl: DEFAULT_CATALOG_INDEX_URL,
      enabled: true,
      // The keys built into Appflare, whatever the seeded row lists.
      keys: [{ keyId: "appflare-2026-09" }, { keyId: "catalog-2026-09" }],
    });
  });
});

describe("addCatalogCore", () => {
  it("adds a catalog whose release verifies with the pasted key, and caches its index", async () => {
    const fixture = await buildArtifactFixture({ keyId: KEY_ID });
    const s = serving(fixture);
    const added = await addCatalogCore(deps(s.fetch), input(fixture));
    expect(added).toEqual({
      id: "acme",
      checked: { slug: "cut", version: "1.0.0", keyId: KEY_ID },
    });
    const record = await readCatalogRecord(createDb(env.DB), "acme");
    expect(record).toMatchObject({
      kind: "custom",
      label: "Acme",
      colour: "blue",
      indexUrl: INDEX_URL,
      enabled: true,
      keys: [{ keyId: KEY_ID, publicKeyBase64: fixture.keys[0]?.publicKeyBase64 }],
    });
    // Its index is cached at once, without the official-only parts.
    const cached = await readCachedCustomCatalogIndex(env.KV, "acme");
    expect(cached?.index.apps.map((a) => a.slug)).toEqual(["cut"]);
    expect(cached?.index.featured).toEqual([]);
    expect(cached?.index.stats).toBeUndefined();
    // The index, then the release's manifest and signature; never the stats file.
    expect(s.hits).toContain(INDEX_URL);
    expect(s.hits.some((u) => u.includes("stats"))).toBe(false);
  });

  it("refuses a key that does not verify the catalog's releases, and adds nothing", async () => {
    const fixture = await buildArtifactFixture({ keyId: KEY_ID });
    const other = await buildArtifactFixture({ keyId: KEY_ID });
    await expect(
      addCatalogCore(deps(serving(fixture).fetch), input(fixture, { publicKeys: pasted(other) })),
    ).rejects.toThrow(
      `The public key does not verify cut 1.0.0 from this catalog: manifest signature does not verify with keyId "${KEY_ID}".`,
    );
    // A pasted key under another id does not match the release's key id at all.
    await expect(
      addCatalogCore(
        deps(serving(fixture).fetch),
        input(fixture, { publicKeys: pasted(fixture, "acme-other") }),
      ),
    ).rejects.toThrow(`no trusted signing key matches keyId "${KEY_ID}"`);
    expect(await customRows()).toEqual([]);
    expect(await env.KV.get(customCatalogIndexKey("acme"))).toBeNull();
  });

  it("refuses an official public key under any key id", async () => {
    const fixture = await buildArtifactFixture({ keyId: KEY_ID });
    const s = serving(fixture);
    const officialKey = signingKeys[0]?.publicKeyBase64 ?? "";
    await expect(
      addCatalogCore(
        deps(s.fetch),
        input(fixture, {
          publicKeys: formatPublicKey({ keyId: "not-official", publicKeyBase64: officialKey }),
        }),
      ),
    ).rejects.toThrow(`The key "not-official" is one of the official catalog's keys.`);
    expect(s.hits).toEqual([]);
  });

  it("takes at most five added catalogs", async () => {
    const fixture = await buildArtifactFixture({ keyId: KEY_ID });
    for (let i = 1; i <= 5; i++) {
      const url = `https://acme${i}.test/index.json`;
      const fetch: FetchLike = async (u, init) =>
        u === url
          ? Response.json(indexOf([fixture.index]))
          : (fixture.serve(u, init) ?? new Response("not found", { status: 404 }));
      await addCatalogCore(deps(fetch), input(fixture, { indexUrl: url, label: `Acme ${i}` }));
    }
    await expect(
      addCatalogCore(deps(serving(fixture).fetch), input(fixture, { label: "Sixth" })),
    ).rejects.toThrow("Appflare takes at most 5 added catalogs. Remove one first.");
    expect(await customRows()).toHaveLength(5);
  });

  it("refuses a key that reuses an official key id before fetching anything", async () => {
    const fixture = await buildArtifactFixture({ keyId: "catalog-2026-09" });
    const s = serving(fixture);
    await expect(
      addCatalogCore(
        deps(s.fetch),
        input(fixture, { publicKeys: pasted(fixture, "catalog-2026-09") }),
      ),
    ).rejects.toThrow('The key id "catalog-2026-09" belongs to the official catalog.');
    expect(s.hits).toEqual([]);
  });

  it("refuses an http URL, an unreadable key, a page that is not an index, and an index without a release", async () => {
    const fixture = await buildArtifactFixture({ keyId: KEY_ID });
    const add = (index: unknown, over: Record<string, string> = {}) =>
      addCatalogCore(deps(serving(fixture, index).fetch), input(fixture, over));
    await expect(
      add(indexOf([fixture.index]), { indexUrl: "http://acme.test/i.json" }),
    ).rejects.toThrow("Enter an https:// URL");
    await expect(add(indexOf([fixture.index]), { publicKeys: "not a key" })).rejects.toThrow(
      "Paste the public key",
    );
    await expect(add({ hello: "world" })).rejects.toThrow("is not a catalog index");
    await expect(add(indexOf([]))).rejects.toThrow("lists no apps yet");
    const { artifacts: _a, digest: _d, ...unreleased } = fixture.index;
    await expect(
      add(
        indexOf([
          {
            ...unreleased,
            tier: "sandbox",
            build: {
              pin: "6056400d47530aa87e4ae5764b37ffca9d00e87f",
              manifest: "https://acme.test/catalog/apps/cut.json",
              manifestDigest: "a".repeat(64),
            },
          },
        ]),
      ),
    ).rejects.toThrow("lists no signed release");
    expect(await customRows()).toEqual([]);
  });

  it("refuses an index URL already in use, the official one included", async () => {
    const fixture = await buildArtifactFixture({ keyId: KEY_ID });
    const s = serving(fixture);
    await addCatalogCore(deps(s.fetch), input(fixture));
    await expect(addCatalogCore(deps(s.fetch), input(fixture, { label: "Again" }))).rejects.toThrow(
      "Acme already uses this index URL.",
    );
    await expect(
      addCatalogCore(deps(s.fetch), input(fixture, { indexUrl: DEFAULT_CATALOG_INDEX_URL })),
    ).rejects.toThrow("Official already uses this index URL.");
  });
});

describe("updateCatalogCore", () => {
  it("changes the label and colour without fetching, and checks a new key first", async () => {
    const fixture = await buildArtifactFixture({ keyId: KEY_ID });
    const other = await buildArtifactFixture({ keyId: KEY_ID });
    const s = serving(fixture);
    await addCatalogCore(deps(s.fetch), input(fixture));
    const before = s.hits.length;
    await updateCatalogCore(deps(s.fetch), {
      ...input(fixture, { label: "Acme apps" }),
      colour: "green",
      id: "acme",
    });
    expect(s.hits.length).toBe(before);
    expect(await readCatalogRecord(createDb(env.DB), "acme")).toMatchObject({
      label: "Acme apps",
      colour: "green",
    });
    await env.KV.put("catalog:acme:manifest:abc", "verified with the old key");
    await expect(
      updateCatalogCore(deps(s.fetch), {
        ...input(fixture, { publicKeys: pasted(other) }),
        id: "acme",
      }),
    ).rejects.toThrow("The public key does not verify cut 1.0.0");
    // A refused change keeps what was verified.
    expect(await env.KV.get("catalog:acme:manifest:abc")).not.toBeNull();
    // The refused key was not saved.
    expect((await readCatalogRecord(createDb(env.DB), "acme"))?.keys[0]?.publicKeyBase64).toBe(
      fixture.keys[0]?.publicKeyBase64,
    );
  });

  it("forgets what the old key verified when the key changes", async () => {
    const fixture = await buildArtifactFixture({ keyId: KEY_ID });
    const s = serving(fixture);
    await addCatalogCore(deps(s.fetch), input(fixture));
    await env.KV.put("catalog:acme:manifest:abc", "verified with the old key");
    await env.KV.put("catalog:acme-2:manifest:abc", "another catalog's");
    await env.KV.put("catalog:manifest:abc", "the official catalog's");
    // The same key, rotated to a list with a second one: the key set changed.
    const second = await buildArtifactFixture({ keyId: "acme-2027-01" });
    const keys = JSON.stringify([
      JSON.parse(pasted(fixture)),
      JSON.parse(pasted(second, "acme-2027-01")),
    ]);
    await updateCatalogCore(deps(s.fetch), { ...input(fixture, { publicKeys: keys }), id: "acme" });
    expect(await env.KV.get("catalog:acme:manifest:abc")).toBeNull();
    expect(await env.KV.get("catalog:acme-2:manifest:abc")).not.toBeNull();
    expect(await env.KV.get("catalog:manifest:abc")).not.toBeNull();
    // Its index is cached again at once.
    expect(await readCachedCustomCatalogIndex(env.KV, "acme")).not.toBeNull();
  });
});

describe("the official catalog", () => {
  it("turns off and on, but is never edited or removed", async () => {
    const fixture = await buildArtifactFixture({ keyId: KEY_ID });
    const d = deps(serving(fixture).fetch);
    await setCatalogEnabledCore(d, { id: "official", enabled: false });
    expect((await readCatalogRecord(createDb(env.DB), "official"))?.enabled).toBe(false);
    // Off: not browsed, not refreshed.
    expect(await readEnabledCatalogs(env, { refreshOnMiss: false })).toEqual([]);
    await setCatalogEnabledCore(d, { id: "official", enabled: true });
    expect(
      (await readEnabledCatalogs(env, { refreshOnMiss: false })).map((r) => r.source.id),
    ).toEqual(["official"]);
    await expect(updateCatalogCore(d, { ...input(fixture), id: "official" })).rejects.toThrow(
      "The official catalog cannot be changed or removed; turn it off instead.",
    );
    await expect(deleteCatalogCore(d, { id: "official" })).rejects.toThrow(
      "The official catalog cannot be changed or removed",
    );
    expect(await readCatalogRecord(createDb(env.DB), "official")).not.toBeNull();
  });
});

describe("deleteCatalogCore", () => {
  async function seedInstall(status: string) {
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, display_name, catalog_version, artifact_url,
         status, installed_at, updated_at, catalog_id)
       VALUES ('i1', 'cut', 'cut', 'Team links', '1.0.0', 'x', ?1, 1, 1, 'acme')`,
    )
      .bind(status)
      .run();
  }

  it("refuses to remove a catalog while apps installed from it are installed, and says why", async () => {
    const fixture = await buildArtifactFixture({ keyId: KEY_ID });
    const d = deps(serving(fixture).fetch);
    await addCatalogCore(d, input(fixture));
    await seedInstall("installed");
    await expect(deleteCatalogCore(d, { id: "acme" })).rejects.toThrow(
      "Acme cannot be removed while apps installed from it are still installed (Team links): their updates and checks come from this catalog, and its key verifies them. Uninstall them first.",
    );
    expect(await readCatalogRecord(createDb(env.DB), "acme")).not.toBeNull();

    await env.DB.prepare("UPDATE installs SET status = 'uninstalled' WHERE id = 'i1'").run();
    await env.KV.put("catalog:acme:manifest:abc", "verified with its key");
    await deleteCatalogCore(d, { id: "acme" });
    expect(await env.KV.get("catalog:acme:manifest:abc")).toBeNull();
    expect(await readCatalogRecord(createDb(env.DB), "acme")).toBeNull();
    expect(await env.KV.get(customCatalogIndexKey("acme"))).toBeNull();
  });
});
