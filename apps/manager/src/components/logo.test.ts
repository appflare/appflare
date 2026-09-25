import { describe, expect, it } from "vitest";
import logoFull from "../../../../docs/assets/logo_full.svg?raw";
import logoFullWhite from "../../../../docs/assets/logo_full_white.svg?raw";
import { CLOUD_ORANGE, CLOUD_PATH, INK_PATHS } from "./logo-paths";

/** The `d` of every path in an SVG, in order. */
function pathsOf(svg: string): string[] {
  return [...svg.matchAll(/<path[^>]* d="([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("Logo", () => {
  it("draws the same paths as the logo files, in both colour variants", () => {
    expect(pathsOf(logoFull)).toEqual([...INK_PATHS, CLOUD_PATH]);
    expect(pathsOf(logoFullWhite)).toEqual([...INK_PATHS, CLOUD_PATH]);
    expect(logoFull).toContain('<g fill="#000">');
    expect(logoFullWhite).toContain('<g fill="#fff">');
    expect(logoFull).toContain(`fill="${CLOUD_ORANGE}"`);
  });
});
