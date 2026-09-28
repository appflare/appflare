import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_PROMPTS } from "./lib/agent-prompts.ts";
import { markdownUrl, pageUrl } from "./lib/shared.ts";
import { source } from "./lib/source.ts";

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

/** Each rule of `_redirects`: source, destination and status. */
function redirectRules(text: string): Array<{ from: string; to: string; status: number }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const [from = "", to = "", status = "302"] = line.split(/\s+/);
      return { from, to, status: Number(status) };
    });
}

describe("_redirects", () => {
  const rules = redirectRules(read("_redirects"));
  const docsPages = source.getPages();
  const pageUrls = new Set(docsPages.map((page) => pageUrl(page.slugs)));
  const markdownUrls = new Set(docsPages.map((page) => markdownUrl(page.slugs)));
  const agentFiles = new Set<string>(Object.values(AGENT_PROMPTS).map((prompt) => prompt.path));
  const served = (path: string) =>
    pageUrls.has(path) || markdownUrls.has(path) || agentFiles.has(path);

  it("sends the former agent prompt pages to the pages that hold their prompts now", () => {
    const to = new Map(rules.map((rule) => [rule.from, rule.to]));
    expect(to.get("/start/install-with-an-agent/")).toBe(AGENT_PROMPTS.install.page);
    expect(to.get("/start/install-with-an-agent")).toBe(AGENT_PROMPTS.install.page);
    expect(to.get("/catalog/submit-with-an-agent/")).toBe(AGENT_PROMPTS.submit.page);
    expect(to.get("/catalog/submit-with-an-agent")).toBe(AGENT_PROMPTS.submit.page);
    expect(to.get("/start/install-with-an-agent.md")).toBe(AGENT_PROMPTS.install.path);
    expect(to.get("/catalog/submit-with-an-agent.md")).toBe(AGENT_PROMPTS.submit.path);
  });

  it("are permanent, lead to something the site serves, and never hide a page", () => {
    for (const { from, to, status } of rules) {
      expect(status, from).toBe(301);
      expect(served(to), `${from} -> ${to}`).toBe(true);
      // Workers static assets follows a redirect even where a file exists.
      expect(served(from), from).toBe(false);
    }
  });
});
