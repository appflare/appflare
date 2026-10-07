import catalog from "virtual:appflare-catalog";
import type { InstallApp } from "../install/request.ts";
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

/** An app as the install pages show it. */
export function installApp(app: SiteApp): InstallApp {
  return {
    slug: app.slug,
    name: app.name,
    pitch: app.pitch,
    icon: app.icon,
    repo: app.repo,
    ...(app.sourceRepo === undefined ? {} : { sourceRepo: app.sourceRepo }),
  };
}

/**
 * Every app's slug, name and repository: what the install pages need to
 * find the catalog's app for a repository link, and to name a saved app.
 */
export function installDirectory(): Array<
  Pick<InstallApp, "slug" | "name" | "repo" | "sourceRepo">
> {
  return catalog.apps.map(({ slug, name, repo, sourceRepo }) => ({
    slug,
    name,
    repo,
    ...(sourceRepo === undefined ? {} : { sourceRepo }),
  }));
}
