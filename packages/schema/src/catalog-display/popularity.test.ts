import { describe, expect, it } from "vitest";
import type { CatalogStats } from "../catalog-stats";
import {
  appPopularity,
  formatCount,
  freshStats,
  STATS_MAX_AGE_MS,
  sortByPopularity,
} from "./popularity";

const at = "2026-09-24T12:00:00.000Z";
const STATS: CatalogStats = {
  generatedAt: at,
  apps: {
    cut: { stars: { count: 40, fetchedAt: at }, installs: null },
    flaremo: { stars: { count: 900, fetchedAt: at }, installs: null },
    mailflare: {
      stars: { count: 5, fetchedAt: at },
      installs: { last30d: 12, active: 30, fetchedAt: at },
    },
    "r2-explorer": { stars: null, installs: { last30d: null, active: null, fetchedAt: at } },
  },
  sources: { github: { ok: true, at }, telemetry: { ok: true, at } },
};

describe("popularity", () => {
  it("shows stats only while they are recent", () => {
    const generated = Date.parse(at);
    expect(freshStats(STATS, new Date(generated + STATS_MAX_AGE_MS))).toBe(STATS);
    expect(freshStats(STATS, new Date(generated + STATS_MAX_AGE_MS + 1))).toBeNull();
    expect(freshStats(null, new Date())).toBeNull();
  });

  it("reads one app's numbers, with null for what is unknown or below the floor", () => {
    expect(appPopularity(STATS, "mailflare")).toEqual({
      stars: 5,
      installs30d: 12,
      activeInstalls: 30,
      installsKnown: true,
    });
    expect(appPopularity(STATS, "r2-explorer")).toEqual({
      stars: null,
      installs30d: null,
      activeInstalls: null,
      installsKnown: true,
    });
    expect(appPopularity(STATS, "cut")?.installsKnown).toBe(false);
    expect(appPopularity(STATS, "unknown")).toBeNull();
    expect(appPopularity(null, "cut")).toBeNull();
  });

  it("drops template and unproven stars when the public repository is known, keeping installs", () => {
    const mailflare = STATS.apps.mailflare;
    if (mailflare === undefined) throw new Error("missing fixture stats");
    const withRepo = (repo?: string): CatalogStats => ({
      ...STATS,
      apps: { mailflare: { ...mailflare, stars: { count: 40, fetchedAt: at, repo } } },
    });
    const expected = { stars: null, installs30d: 12, activeInstalls: 30, installsKnown: true };
    expect(appPopularity(withRepo("packager/template"), "mailflare", "upstream/app")).toEqual(
      expected,
    );
    expect(appPopularity(withRepo(), "mailflare", "upstream/app")).toEqual(expected);
    expect(appPopularity(withRepo("UPSTREAM/App"), "mailflare", "upstream/app")).toEqual({
      ...expected,
      stars: 40,
    });
  });

  it("hides proven stars beside an older index whose repository is unknown", () => {
    const proven: CatalogStats = {
      ...STATS,
      apps: {
        cut: { stars: { count: 9000, fetchedAt: at, repo: "upstream/app" }, installs: null },
      },
    };
    expect(appPopularity(proven, "cut")?.stars).toBeNull();
    expect(appPopularity(STATS, "cut")?.stars).toBe(40);
  });

  it("orders by active installs, then 30-day installs, then stars, apps without numbers last", () => {
    const apps = ["unknown", "cut", "r2-explorer", "flaremo", "mailflare"].map((slug) => ({
      slug,
      popularity: appPopularity(STATS, slug),
    }));
    expect(sortByPopularity(apps).map((a) => a.slug)).toEqual([
      "mailflare",
      "flaremo",
      "cut",
      "unknown",
      "r2-explorer",
    ]);
    // The input is left as it was.
    expect(apps[0]?.slug).toBe("unknown");
  });

  it("formats counts for labels", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(1234)).toBe("1.2k");
    expect(formatCount(12_345)).toBe("12k");
    expect(formatCount(1_340_000)).toBe("1.3M");
  });
});
