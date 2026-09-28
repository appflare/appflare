import catalog from "virtual:appflare-catalog";
import type { SiteApp, SiteCatalog, SiteCategory } from "./site-catalog.ts";

/**
 * The catalog the site was built from. Routes load this module with a
 * dynamic `import()` in their loaders, so the data is a chunk of its own that
 * only the catalog pages download, never the docs pages.
 */
export const siteCatalog: SiteCatalog = catalog;

export function findApp(slug: string): SiteApp | undefined {
  return catalog.apps.find((app) => app.slug === slug);
}

export function findCategory(id: string): SiteCategory | undefined {
  return catalog.categories.find((category) => category.id === id);
}
