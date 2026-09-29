import { createFileRoute, notFound } from "@tanstack/react-router";
import { slugsFromOgImagePath } from "../../lib/shared.ts";
import { source } from "../../lib/source.ts";
import { renderOgCard } from "../../og/cards.tsx";
import { firstScreenshot, ogCardFor } from "../../og/resolve.ts";

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
        const [
          { siteCatalog },
          { default: icons },
          { default: appScreenshots },
          { default: docsScreenshots },
        ] = await Promise.all([
          import("../../catalog/data.ts"),
          import("virtual:appflare-catalog-og-icons"),
          import("virtual:appflare-catalog-og-screenshots"),
          import("virtual:appflare-og-docs-screenshots"),
        ]);
        // Only the page these slugs name is ever asked for, so it is read here, once.
        const found = source.getPage(slugs);
        const page =
          found === undefined
            ? null
            : {
                title: found.data.title,
                description: found.data.description,
                url: found.url,
                screenshot: firstScreenshot(await found.data.getText("raw")),
              };
        const card = ogCardFor(slugs, {
          page: () => page,
          tree: source.getPageTree(),
          catalog: siteCatalog,
          icons,
          appScreenshots,
          docsScreenshots,
        });
        if (card === null) throw notFound();
        return renderOgCard(card);
      },
    },
  },
});
