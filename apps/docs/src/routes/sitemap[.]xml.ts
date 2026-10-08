import { createFileRoute } from "@tanstack/react-router";
import { siteCatalog } from "../catalog/data.ts";
import { appPath, catalogPagePaths } from "../catalog/urls.ts";
import { pageUrl } from "../lib/shared.ts";
import { renderSitemap } from "../lib/sitemap.ts";
import { source } from "../lib/source.ts";

/**
 * `sitemap.xml`: the front page, every docs page and every catalog page, by its
 * canonical URL. An app's page changes when the catalog last tested the app (the
 * page shows that day), so it carries that day, or the day it was added.
 */
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          renderSitemap([
            "/",
            ...source.getPages().map((page) => pageUrl(page.slugs)),
            ...catalogPagePaths(siteCatalog),
            ...siteCatalog.apps.map((app) => ({
              path: appPath(app.slug),
              lastmod: app.lastVerified ?? app.addedAt,
            })),
          ]),
          { headers: { "Content-Type": "application/xml; charset=utf-8" } },
        ),
    },
  },
});
