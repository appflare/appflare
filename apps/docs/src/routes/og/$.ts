import { createFileRoute, notFound } from "@tanstack/react-router";
import { renderOgImage } from "../../lib/og-image.tsx";
import { slugsFromOgImagePath } from "../../lib/shared.ts";
import { source } from "../../lib/source.ts";

/**
 * A page's OpenGraph image (`/og/start/install/image.png`). Only the build
 * requests it: the OpenGraph image step of vite.config.ts writes one PNG per
 * page into the static output, so the deployed site never runs this.
 */
export const Route = createFileRoute("/og/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slugs = slugsFromOgImagePath(params._splat ?? "");
        const page = slugs && source.getPage(slugs);
        if (!page) throw notFound();
        return renderOgImage({ title: page.data.title, description: page.data.description });
      },
    },
  },
});
