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

  it("gives a page the latest of its days, as a day", () => {
    const xml = renderSitemap([
      "/apps/a/",
      { path: "/apps/a/", lastmod: "2026-09-01T10:00:00.000Z" },
      { path: "/apps/a/", lastmod: "2026-10-08T23:59:00.000Z" },
      { path: "/apps/b/", lastmod: null },
    ]);
    expect(xml).toContain(
      `  <url><loc>${SITE_URL}/apps/a/</loc><lastmod>2026-10-08</lastmod></url>`,
    );
    expect(xml).toContain(`  <url><loc>${SITE_URL}/apps/b/</loc></url>`);
    expect(xml.match(/apps\/a\//g)).toHaveLength(1);
  });
});
