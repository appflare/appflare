import { describe, expect, it } from "vitest";
import { siteUrl } from "./shared.ts";
import { renderSitemap } from "./sitemap.ts";

describe("renderSitemap", () => {
  it("lists each page once, sorted, by absolute URL, in the sitemaps.org namespace", () => {
    const xml = renderSitemap(["/start/install/", "/", "/start/install/", "/a&b/"]);
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        `  <url><loc>${siteUrl}/</loc></url>`,
        `  <url><loc>${siteUrl}/a&amp;b/</loc></url>`,
        `  <url><loc>${siteUrl}/start/install/</loc></url>`,
        "</urlset>",
        "",
      ].join("\n"),
    );
  });
});
