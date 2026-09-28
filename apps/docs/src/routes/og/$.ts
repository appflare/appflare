import { createFileRoute, notFound } from "@tanstack/react-router";
import { slugsFromOgImagePath } from "../../lib/shared.ts";
import { source } from "../../lib/source.ts";
import { renderOgCard } from "../../og/cards.tsx";
import { ogCardFor } from "../../og/resolve.ts";

/**
 * A page's OpenGraph image (`/og/start/install/image.png`); see `og/resolve.ts`
 * for which card each path draws. Only the build requests it: the OpenGraph
 * image step of vite.config.ts writes one PNG per page into the static output,
 * so the deployed site never runs this.
 */
export const Route = createFileRoute("/og/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slugs = slugsFromOgImagePath(params._splat ?? "");
        if (slugs === undefined) throw notFound();
        const [{ siteCatalog }, { default: icons }] = await Promise.all([
          import("../../catalog/data.ts"),
          import("virtual:appflare-catalog-og-icons"),
        ]);
        const card = ogCardFor(slugs, {
          page: (pageSlugs) => {
            const page = source.getPage(pageSlugs);
            return page ? { ...page.data, url: page.url } : null;
          },
          tree: source.getPageTree(),
          catalog: siteCatalog,
          icons,
        });
        if (card === null) throw notFound();
        return renderOgCard(card);
      },
    },
  },
});
