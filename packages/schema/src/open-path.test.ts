import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogManifestSchema, strictCatalogManifestSchema } from "./catalog";
import {
  appOpenUrl,
  MAX_OPEN_PATH_LENGTH,
  OPEN_PATH_PATTERN,
  openPathProblem,
  openPathSchema,
} from "./open-path";

const manifest = {
  slug: "sink",
  name: "Sink",
  summary: "A link shortener with analytics.",
  tagline: "Short links with analytics",
  repo: "ccbikai/Sink",
  license: "MIT",
  categories: ["utilities"],
  source: { ref: "v0.1.0", sha: "0".repeat(40) },
  install: { packageManager: "pnpm", wranglerConfig: "wrangler.jsonc" },
  plan: "free",
};

describe("openPath", () => {
  it("accepts a path on the app's address, with or without a final slash", () => {
    for (const path of ["/dashboard", "/admin/", "/app/home", "/a-b_c.d~e/f@g:h+i=j,k"]) {
      expect(openPathProblem(path), path).toBeNull();
      expect(new RegExp(OPEN_PATH_PATTERN).test(path), path).toBe(true);
      expect(openPathSchema.safeParse(path).success, path).toBe(true);
    }
  });

  it("refuses anything that is not a plain path on the app's own address", () => {
    const cases: Array<[string, string]> = [
      ["dashboard", 'starting with "/"'],
      ["https://evil.example/dashboard", 'starting with "/"'],
      ["//evil.example/dashboard", '"//"'],
      ["/", "leave openPath out"],
      ["/dashboard?tab=1", "without a query"],
      ["/#/dashboard", "fragment"],
      ["/a//b", '"//"'],
      ["/a/../b", '".."'],
      ["/./a", '"."'],
      ["/a b", "may hold letters"],
      ["/a\\b", "may hold letters"],
      ["/a%2fb", "may hold letters"],
      [`/${"a".repeat(MAX_OPEN_PATH_LENGTH)}`, `at most ${MAX_OPEN_PATH_LENGTH}`],
    ];
    for (const [path, message] of cases) {
      expect(openPathProblem(path), path).toContain(message);
      expect(openPathSchema.safeParse(path).success, path).toBe(false);
    }
    // The JSON Schema's pattern refuses what it can say without words.
    for (const path of ["dashboard", "//evil.example", "/", "/a?b", "/a b", "/a\\b"]) {
      expect(new RegExp(OPEN_PATH_PATTERN).test(path), path).toBe(false);
    }
  });

  it("is an optional top-level field the strict and lenient schemas both keep", () => {
    expect(catalogManifestSchema.parse(manifest).openPath).toBeUndefined();
    const withPath = { ...manifest, openPath: "/dashboard" };
    expect(catalogManifestSchema.parse(withPath).openPath).toBe("/dashboard");
    expect(strictCatalogManifestSchema.parse(withPath).openPath).toBe("/dashboard");
    const bad = strictCatalogManifestSchema.safeParse({ ...manifest, openPath: "dashboard" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.path.join("."))).toContain("openPath");
  });

  it("is in the published JSON Schema with its pattern and limit", () => {
    const schema = JSON.parse(
      readFileSync(new URL("../json-schema/v1.json", import.meta.url), "utf8"),
    ) as { properties: Record<string, { pattern?: string; maxLength?: number }> };
    expect(schema.properties.openPath?.pattern).toBe(OPEN_PATH_PATTERN);
    expect(schema.properties.openPath?.maxLength).toBe(MAX_OPEN_PATH_LENGTH);
  });
});

describe("appOpenUrl", () => {
  it("puts the path after the app's address", () => {
    expect(appOpenUrl("https://sink.example.workers.dev", "/dashboard")).toBe(
      "https://sink.example.workers.dev/dashboard",
    );
    expect(appOpenUrl("https://links.example.com/", "/admin/")).toBe(
      "https://links.example.com/admin/",
    );
  });

  it("opens the address itself without a usable path, and nothing without an address", () => {
    expect(appOpenUrl("https://links.example.com", undefined)).toBe("https://links.example.com");
    expect(appOpenUrl("https://links.example.com", null)).toBe("https://links.example.com");
    expect(appOpenUrl("https://links.example.com", "//evil.example")).toBe(
      "https://links.example.com",
    );
    expect(appOpenUrl(null, "/dashboard")).toBeNull();
  });
});
