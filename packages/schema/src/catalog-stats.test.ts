import { describe, expect, it } from "vitest";
import { catalogStatsSchema, MIN_PUBLISHED_INSTALLS } from "./catalog-stats";

const at = "2026-09-24T12:23:05Z";

function valid() {
  return {
    generatedAt: at,
    apps: {
      cut: {
        stars: { count: 12, fetchedAt: at },
        installs: { last30d: null, active: 57, fetchedAt: at },
      },
      "r2-explorer": { stars: null, installs: null },
    },
    sources: { github: { ok: true, at }, telemetry: { ok: false, at: null } },
  };
}

describe("catalogStatsSchema", () => {
  it("accepts stars, install counts, and apps with nothing known", () => {
    const parsed = catalogStatsSchema.parse(valid());
    expect(parsed.apps.cut?.installs?.active).toBe(57);
    expect(parsed.apps["r2-explorer"]?.stars).toBeNull();
  });

  it("refuses install counts below the published floor, and negative stars", () => {
    const low = valid();
    low.apps.cut.installs.active = MIN_PUBLISHED_INSTALLS - 1;
    expect(catalogStatsSchema.safeParse(low).success).toBe(false);
    const negative = valid();
    negative.apps.cut.stars.count = -1;
    expect(catalogStatsSchema.safeParse(negative).success).toBe(false);
  });

  it("refuses a file without its sources", () => {
    const { sources: _sources, ...bare } = valid();
    expect(catalogStatsSchema.safeParse(bare).success).toBe(false);
  });

  it("reads repository provenance while accepting older star counts", () => {
    const stats = valid();
    const withRepo = {
      ...stats,
      apps: {
        cut: { ...stats.apps.cut, stars: { ...stats.apps.cut.stars, repo: "MendyLanda/cut" } },
      },
    };
    expect(catalogStatsSchema.parse(withRepo).apps.cut?.stars?.repo).toBe("MendyLanda/cut");
    expect(catalogStatsSchema.parse(stats).apps.cut?.stars?.repo).toBeUndefined();
    withRepo.apps.cut.stars.repo = "https://github.com/MendyLanda/cut";
    expect(catalogStatsSchema.safeParse(withRepo).success).toBe(false);
  });
});
