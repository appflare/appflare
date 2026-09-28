import type { SiteCatalog } from "../catalog/site-catalog.ts";

/**
 * What the front page (`/`) shows from the catalog, worked out at build time
 * so the page carries a few numbers and eighteen apps rather than the whole
 * catalog.
 */

/** Apps shown in the front page's grid. */
export const SHOWCASE_SIZE = 18;

export interface LandingApp {
  slug: string;
  name: string;
  icon: string;
  /** The label of the app's first category, or null when it has none. */
  category: string | null;
}

export interface LandingData {
  /** Apps in the catalog. */
  apps: number;
  categories: number;
  /** Apps that run on the Workers Free plan. */
  freePlan: number;
  /** The best-known apps that have an icon of their own, the most stars first. */
  showcase: LandingApp[];
}

export function landingData(catalog: SiteCatalog, size = SHOWCASE_SIZE): LandingData {
  const label = new Map(catalog.categories.map((category) => [category.id, category.label]));
  const showcase = catalog.apps
    .flatMap((app) => (app.icon === null ? [] : [{ app, icon: app.icon }]))
    .sort((a, b) => (b.app.popularity?.stars ?? 0) - (a.app.popularity?.stars ?? 0))
    .slice(0, size)
    .map(({ app, icon }) => ({
      slug: app.slug,
      name: app.name,
      icon,
      category: label.get(app.categories[0] ?? "") ?? null,
    }));
  return {
    apps: catalog.apps.length,
    categories: catalog.categories.length,
    freePlan: catalog.apps.filter((app) => app.plan === "free").length,
    showcase,
  };
}

/** The documentation pages the front page links to. */
export const landingLinks = {
  overview: "/start/overview/",
  install: "/start/install/",
  deployButton: "/start/deploy-button/",
  installApps: "/guides/install-apps/",
  updates: "/guides/updates/",
  automaticUpdates: "/guides/updates/#automatic-updates",
  updateAppflare: "/guides/update-appflare/#update-automatically",
  domains: "/guides/custom-domains/",
  users: "/guides/users/",
  health: "/guides/health/",
  notifications: "/guides/notifications/",
  security: "/security/",
  faq: "/faq/",
  catalogHowItWorks: "/catalog/how-it-works/",
  submit: "/catalog/submit/",
  badge: "/catalog/install-badge/",
  telemetry: "/telemetry/",
  privacy: "/privacy/",
} as const;

export const catalogRepositoryUrl = "https://github.com/appflare/catalog";
