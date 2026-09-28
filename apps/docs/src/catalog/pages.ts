import { categoryLabel } from "@appflare/schema/catalog-display";
import type { SiteCatalog, SiteCategory } from "./site-catalog.ts";
import { appPath, appsPath, categoryPath } from "./urls.ts";

/**
 * The words each catalog page is found by: its title, its description, and
 * the OpenGraph card drawn for it. The routes, the sitemap, `llms.txt` and
 * the search index all read them here, so they never disagree.
 */

export const appsPageTitle = "Apps";
export const appsPageDescription =
  "Apps you can add to your own Cloudflare account with Appflare. Each one runs in your account, under your control.";

export function categoryTitle(category: Pick<SiteCategory, "id">): string {
  return `${categoryLabel(category.id)} apps`;
}

export function categoryDescription(category: Pick<SiteCategory, "id" | "count">): string {
  const apps = category.count === 1 ? "1 app" : `${category.count} apps`;
  return `${apps} in the ${categoryLabel(category.id)} category that you can add to your own Cloudflare account with Appflare.`;
}

/** One catalog page, as the site's indexes list it. */
export interface CatalogPageEntry {
  url: string;
  title: string;
  description: string;
}

/** Every catalog page: the apps page, then the apps by name, then the categories. */
export function catalogPageEntries(catalog: Pick<SiteCatalog, "apps" | "categories">): {
  apps: CatalogPageEntry;
  appPages: CatalogPageEntry[];
  categoryPages: CatalogPageEntry[];
} {
  return {
    apps: { url: appsPath, title: appsPageTitle, description: appsPageDescription },
    appPages: [...catalog.apps]
      .sort((a, b) => a.name.localeCompare(b.name, "en"))
      .map((app) => ({ url: appPath(app.slug), title: app.name, description: app.pitch })),
    categoryPages: catalog.categories.map((category) => ({
      url: categoryPath(category.id),
      title: categoryTitle(category),
      description: categoryDescription(category),
    })),
  };
}
