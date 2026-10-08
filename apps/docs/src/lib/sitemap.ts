import { SITE_URL } from "./shared.ts";

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** A page of the sitemap: its site-relative URL, and the day it last changed when that is known. */
export type SitemapEntry = string | { path: string; lastmod: string | null };

/** The `YYYY-MM-DD` day of an ISO date or timestamp. */
function day(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * A sitemap (https://www.sitemaps.org/protocol.html) of the given pages. A page
 * listed twice is listed once, with the later of its days.
 */
export function renderSitemap(entries: readonly SitemapEntry[]): string {
  const pages = new Map<string, string | null>();
  for (const entry of entries) {
    const { path, lastmod } = typeof entry === "string" ? { path: entry, lastmod: null } : entry;
    const days = [pages.get(path) ?? null, lastmod === null ? null : day(lastmod)];
    pages.set(
      path,
      days
        .filter((d) => d !== null)
        .sort()
        .at(-1) ?? null,
    );
  }
  const urls = [...pages.keys()].sort().map((path) => {
    const lastmod = pages.get(path);
    const loc = `<loc>${escapeXml(`${SITE_URL}${path}`)}</loc>`;
    return `  <url>${loc}${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
