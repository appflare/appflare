import { describe, expect, it } from "vitest";
import { canIndexSearch, type Host } from "./search.ts";

function host(platform: NodeJS.Platform, arch: string, pageSize?: number): Host {
  return { platform, arch, pageSize: () => pageSize };
}

describe("canIndexSearch", () => {
  it("runs on hosts Pagefind's binaries support", () => {
    expect(canIndexSearch(host("linux", "x64", 4096))).toBe(true);
    expect(canIndexSearch(host("darwin", "arm64", 16384))).toBe(true);
    expect(canIndexSearch(host("linux", "arm64", 4096))).toBe(true);
  });

  it("skips Linux arm64 kernels with pages larger than 4 KiB", () => {
    expect(canIndexSearch(host("linux", "arm64", 16384))).toBe(false);
    expect(canIndexSearch(host("linux", "arm64", 65536))).toBe(false);
  });

  it("assumes it can run when the page size is unknown", () => {
    expect(canIndexSearch(host("linux", "arm64"))).toBe(true);
  });
});
