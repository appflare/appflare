import { describe, expect, it } from "vitest";
import { SITE_URL } from "./shared.ts";
import { renderSitemap } from "./sitemap.ts";

describe("renderSitemap", () => {
  it("lists each page once, sorted, by absolute URL, in the sitemaps.org namespace", () => {
    const xml = renderSitemap(["/start/install/", "/", "/start/install/", "/a&b/"]);
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        `  <url><loc>${SITE_URL}/</loc></url>`,
        `  <url><loc>${SITE_URL}/a&amp;b/</loc></url>`,
        `  <url><loc>${SITE_URL}/start/install/</loc></url>`,
        "</urlset>",
        "",
      ].join("\n"),
    );
  });
});
