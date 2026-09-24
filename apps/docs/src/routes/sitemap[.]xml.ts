import { createFileRoute } from "@tanstack/react-router";
import { pageUrl } from "../lib/shared.ts";
import { renderSitemap } from "../lib/sitemap.ts";
import { source } from "../lib/source.ts";

/** `sitemap.xml`: every docs page, by its canonical URL. */
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(renderSitemap(source.getPages().map((page) => pageUrl(page.slugs))), {
          headers: { "Content-Type": "application/xml; charset=utf-8" },
        }),
    },
  },
});
