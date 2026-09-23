import type { AssetFile } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  ASSET_STEP_BYTES,
  ASSET_STEP_SUBREQUESTS,
  assetStepCost,
  planAssetParts,
} from "./asset-parts";

/** `count` files of `size` bytes, `gap` bytes apart, in shuffled order. */
function files(count: number, size: number, gap = 30): AssetFile[] {
  const out = Array.from({ length: count }, (_, i) => ({
    route: `/f${i}.js`,
    path: `assets/f${i}.js`,
    size,
    sha256: "0".repeat(64),
    hash: i.toString(16).padStart(32, "0"),
    offset: 100 + i * (size + gap),
  }));
  return out.reverse();
}

/** Every job unit stays under this many subrequests per call. */
const UNIT_LIMIT = 40;

describe("planAssetParts", () => {
  it("keeps a bucket of 30 small files in one step: one range, one redirect, one upload", () => {
    const parts = planAssetParts(files(30, 2_000), false);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.ranges).toBe(1);
    expect(parts[0]?.subrequests).toBe(3);
    expect(parts[0]?.files.map((f) => f.route)).toEqual(
      Array.from({ length: 30 }, (_, i) => `/f${i}.js`),
    );
  });

  it("splits single-file uploads so no part passes the unit limit", () => {
    const parts = planAssetParts(files(80, 2_000), true);
    expect(parts.map((p) => p.files.length)).toEqual([34, 34, 12]);
    for (const part of parts) {
      expect(part.subrequests).toBe(assetStepCost(1, part.files.length, true));
      expect(part.subrequests).toBeLessThan(UNIT_LIMIT);
    }
  });

  it("splits files scattered across the zip by their range count", () => {
    // Every file is more than the allowed gap away from the next.
    const parts = planAssetParts(files(50, 1_000, 512 * 1024), false);
    expect(parts.map((p) => p.ranges)).toEqual([34, 16]);
    for (const part of parts) {
      expect(part.subrequests).toBeLessThanOrEqual(ASSET_STEP_SUBREQUESTS);
    }
    expect(parts.flatMap((p) => p.files)).toHaveLength(50);
  });

  it("splits by bytes, and gives a file larger than a step's bytes a step of its own", () => {
    const mib = 1024 * 1024;
    const parts = planAssetParts(files(5, 6 * mib), false);
    expect(parts.map((p) => p.files.length)).toEqual([2, 2, 1]);
    for (const part of parts) expect(part.bytes).toBeLessThanOrEqual(ASSET_STEP_BYTES);
    const huge = planAssetParts(files(1, 20 * mib), false);
    expect(huge).toHaveLength(1);
    expect(huge[0]?.bytes).toBe(20 * mib);
  });

  it("counts no fetch for empty files", () => {
    const empty = files(3, 0);
    const parts = planAssetParts(empty, false);
    expect(parts).toEqual([{ files: empty.reverse(), ranges: 0, bytes: 0, subrequests: 1 }]);
  });
});
