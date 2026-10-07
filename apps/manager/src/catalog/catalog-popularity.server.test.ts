import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthSession } from "../auth/guards";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { manifestCacheKey } from "./app-manifest.server";
import { readCatalogEntry } from "./catalog-entry.server";
import { readCatalogList } from "./catalog-list.server";
import { CATALOG_INDEX_KEY, forgetParsedIndexes } from "./index.server";
import { CATALOG_STATS_KEY } from "./stats.server";

const member: AuthSession = {
  user: { id: "u1", email: "m@example.com", name: "M", role: "member" },
  session: { id: "s1", expiresAt: new Date("2099-01-01T00:00:00.000Z") },
};

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  forgetParsedIndexes();
});

describe("catalog star provenance", () => {
  it.each([
    {
      indexRepo: "upstream/app",
      starsRepo: "packager/template",
      listedStars: null,
      detailStars: null,
    },
    { indexRepo: "upstream/app", starsRepo: undefined, listedStars: null, detailStars: null },
    { indexRepo: "upstream/app", starsRepo: "UPSTREAM/App", listedStars: 9000, detailStars: 9000 },
    { indexRepo: undefined, starsRepo: "upstream/app", listedStars: null, detailStars: 9000 },
    {
      indexRepo: "packager/template",
      starsRepo: "packager/template",
      listedStars: 9000,
      detailStars: null,
    },
  ])(
    "matches listing $indexRepo and verified manifest with stars from $starsRepo",
    async ({ indexRepo, starsRepo, listedStars, detailStars }) => {
      const fixture = await buildArtifactFixture({
        catalog: { repo: "packager/template", upstreamRepo: "upstream/app" },
      });
      const now = new Date().toISOString();
      await env.KV.put(
        CATALOG_INDEX_KEY,
        JSON.stringify({
          generatedAt: now,
          stats: "https://catalog.test/stats.json",
          featured: [],
          apps: [{ ...fixture.index, repo: indexRepo }],
        }),
      );
      // The trusted manifest cache represents the result of signature verification.
      await env.KV.put(
        manifestCacheKey(fixture.digest),
        new TextDecoder().decode(fixture.manifestBytes),
      );
      await env.KV.put(
        CATALOG_STATS_KEY,
        JSON.stringify({
          generatedAt: now,
          sources: { github: { ok: true, at: now }, telemetry: { ok: true, at: now } },
          apps: {
            cut: {
              stars: { count: 9000, fetchedAt: now, repo: starsRepo },
              installs: { last30d: 12, active: 30, fetchedAt: now },
            },
          },
        }),
      );
      const list = await readCatalogList(member);
      expect(list.apps[0]?.popularity).toEqual({
        stars: listedStars,
        installs30d: 12,
        activeInstalls: 30,
        installsKnown: true,
      });
      const detail = await readCatalogEntry("cut", async () => member);
      expect(detail.error).toBeNull();
      expect(detail.catalog?.repo).toBe("packager/template");
      expect(detail.catalog?.upstreamRepo).toBe("upstream/app");
      expect(detail.popularity).toEqual({
        stars: detailStars,
        installs30d: 12,
        activeInstalls: 30,
        installsKnown: true,
      });
    },
  );
});
