import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");

describe("the Install badge", () => {
  const svg = read("badge.svg");
  const root = /^<svg\b[^>]*>/.exec(svg)?.[0] ?? "";

  it("is as tall as Cloudflare's Deploy button, and about as wide", () => {
    expect(root).toMatch(/\bheight="39"/);
    const width = Number(/\bwidth="(\d+(?:\.\d+)?)"/.exec(root)?.[1]);
    expect(width).toBeGreaterThanOrEqual(160);
    expect(width).toBeLessThanOrEqual(220);
    expect(root).toContain(`viewBox="0 0 ${width} 39"`);
  });

  it("stays small", () => {
    expect(Buffer.byteLength(svg)).toBeLessThan(10 * 1024);
  });

  it("names itself for screen readers", () => {
    expect(root).toMatch(/\brole="img"/);
    expect(svg).toContain("<title");
    expect(svg).toMatch(/<title[^>]*>Install with Appflare<\/title>/);
  });

  it("draws its words as shapes and loads nothing, as an image in a README must", () => {
    expect(svg).not.toMatch(
      /<text\b|<style\b|<script\b|<image\b|<foreignObject\b|font-family|@import|href=/,
    );
  });
});

/** Each path pattern in `_headers` with the headers it sets. */
function headerRules(text: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }
    const colon = line.indexOf(":");
    current?.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return rules;
}

describe("_headers", () => {
  const rules = headerRules(read("_headers"));

  it("keeps every page out of other sites' frames", () => {
    const all = rules.get("/*");
    expect(all?.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(all?.get("x-frame-options")).toBe("DENY");
  });

  it("lets other sites show the badge, cached for a day", () => {
    const badge = rules.get("/badge.svg");
    expect(badge?.get("cache-control")).toBe("public, max-age=86400");
    expect(badge?.get("cross-origin-resource-policy")).toBe("cross-origin");
  });
});
