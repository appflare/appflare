import { createFileRoute } from "@tanstack/react-router";
import { siteCatalog } from "../catalog/data.ts";
import { catalogPagePaths } from "../catalog/urls.ts";
import { pageUrl } from "../lib/shared.ts";
import { renderSitemap } from "../lib/sitemap.ts";
import { source } from "../lib/source.ts";

/** `sitemap.xml`: the front page, every docs page and every catalog page, by its canonical URL. */
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          renderSitemap([
            "/",
            ...source.getPages().map((page) => pageUrl(page.slugs)),
            ...catalogPagePaths(siteCatalog),
          ]),
          { headers: { "Content-Type": "application/xml; charset=utf-8" } },
        ),
    },
  },
});
