import { describe, expect, it } from "vitest";
import {
  COVER_HEIGHT,
  COVER_WIDTH,
  MAX_COVER_BYTES,
  MAX_ICON_BYTES,
  MAX_ICON_PX,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_PX,
  MAX_SCREENSHOTS,
  MIN_ICON_PX,
  MIN_SCREENSHOT_PX,
} from "./media";

describe("media limits", () => {
  it("size icons, covers and screenshots as catalogs check them", () => {
    expect([MIN_ICON_PX, MAX_ICON_PX, MAX_ICON_BYTES]).toEqual([64, 1024, 256 * 1024]);
    expect([COVER_WIDTH, COVER_HEIGHT, MAX_COVER_BYTES]).toEqual([1200, 630, 1024 * 1024]);
    expect([MAX_SCREENSHOTS, MIN_SCREENSHOT_PX, MAX_SCREENSHOT_PX, MAX_SCREENSHOT_BYTES]).toEqual([
      8,
      320,
      2560,
      2 * 1024 * 1024,
    ]);
  });
});
