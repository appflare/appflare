import { createFileRoute, notFound } from "@tanstack/react-router";
import { appsPageDescription, categoryDescription, categoryTitle } from "../../catalog/pages.ts";
import { renderAppOgImage, renderOgImage } from "../../lib/og-image.tsx";
import { slugsFromOgImagePath } from "../../lib/shared.ts";
import { source } from "../../lib/source.ts";

/**
 * The card of a catalog page: `/og/apps/image.png` for the apps page,
 * `/og/apps/<slug>/image.png` for an app without a cover, and
 * `/og/categories/<id>/image.png`. Null when `slugs` names none of them.
 */
async function catalogCard(slugs: readonly string[]): Promise<Response | null> {
  const [section, id, ...rest] = slugs;
  if (rest.length > 0) return null;
  const { findApp, findCategory } = await import("../../catalog/data.ts");
  if (section === "apps" && id === undefined) {
    return renderOgImage({ title: "Apps", description: appsPageDescription });
  }
  if (section === "apps" && id !== undefined) {
    const app = findApp(id);
    if (!app) return null;
    const { default: icons } = await import("virtual:appflare-catalog-og-icons");
    return renderAppOgImage({ name: app.name, tagline: app.pitch, icon: icons[app.slug] ?? null });
  }
  if (section === "categories" && id !== undefined) {
    const category = findCategory(id);
    if (!category) return null;
    return renderOgImage({
      title: categoryTitle(category),
      description: categoryDescription(category),
    });
  }
  return null;
}

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
        if (slugs === undefined) throw notFound();
        const page = source.getPage(slugs);
        if (page) {
          return renderOgImage({ title: page.data.title, description: page.data.description });
        }
        const card = await catalogCard(slugs);
        if (card === null) throw notFound();
        return card;
      },
    },
  },
});
