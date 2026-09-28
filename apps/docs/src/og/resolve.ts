import { categoryLabel, comparePopularity } from "@appflare/schema/catalog-display";
import type { Node as PageTreeNode, Root as PageTreeRoot } from "fumadocs-core/page-tree";
import { appsPageDescription } from "../catalog/pages.ts";
import type { SiteApp, SiteCatalog } from "../catalog/site-catalog.ts";
import { appPath, appsPath, categoryPath, installPath } from "../catalog/urls.ts";
import { pageUrl } from "../lib/shared.ts";
import type { CardApp, OgCard } from "./cards.tsx";

/**
 * Which card each OpenGraph image path draws. The paths follow the pages:
 *
 * - `/og/image.png`: the site's own card, for the front page and the pages
 *   without a card of their own;
 * - `/og/<page>/image.png`: a docs page;
 * - `/og/apps/image.png`, `/og/apps/<slug>/image.png`,
 *   `/og/categories/<id>/image.png`, `/og/install/<slug>/image.png`: the
 *   catalog pages and an app's install page.
 */

/** The site's card: the front page's promise, in the words the front page uses. */
export const siteCard = {
  kind: "site",
  title: "The app manager for your own Cloudflare account",
  description:
    "One Worker in your account installs apps built for Workers and keeps them updated, with a rollback when you need one.",
} as const satisfies OgCard;

/** What {@link ogCardFor} reads: the docs pages and the catalog. */
export interface CardSources {
  /** A docs page by its slugs. */
  page(slugs: string[]): { title: string; description?: string | undefined; url: string } | null;
  /** The docs page tree, for the heading a page is listed under. */
  tree: PageTreeRoot;
  catalog: Pick<SiteCatalog, "apps" | "categories">;
  /** App icons as data URIs, by slug. */
  icons: Readonly<Record<string, string>>;
}

/**
 * The heading a docs page is listed under in the sidebar ("Getting started"),
 * or null. The last heading is the catch-all "More", which says nothing
 * about the page, so it is left out.
 */
export function docsSection(tree: PageTreeRoot, url: string): string | null {
  let heading: string | null = null;
  let found: string | null | undefined;
  const walk = (nodes: readonly PageTreeNode[]) => {
    for (const node of nodes) {
      if (found !== undefined) return;
      if (node.type === "separator") heading = typeof node.name === "string" ? node.name : null;
      else if (node.type === "page" && node.url === url) found = heading;
      else if (node.type === "folder") {
        if (node.index?.url === url) found = heading;
        else walk(node.children);
      }
    }
  };
  walk(tree.children);
  return found === undefined || found === "More" ? null : found;
}

function cardApp(app: SiteApp, icons: Readonly<Record<string, string>>): CardApp {
  return { name: app.name, pitch: app.pitch, icon: icons[app.slug] ?? null };
}

/** The apps a list card shows: the most popular first, those with an icon before the rest. */
function listed(apps: readonly SiteApp[], icons: Readonly<Record<string, string>>): CardApp[] {
  return [...apps]
    .sort((a, b) => comparePopularity(a.popularity, b.popularity))
    .map((app) => cardApp(app, icons))
    .sort((a, b) => Number(b.icon !== null) - Number(a.icon !== null));
}

/** The card an OpenGraph image path's slugs draw, or null when they name nothing. */
export function ogCardFor(slugs: readonly string[], sources: CardSources): OgCard | null {
  if (slugs.length === 0) return siteCard;
  const page = sources.page([...slugs]);
  if (page !== null) {
    return {
      kind: "docs",
      section: docsSection(sources.tree, page.url),
      title: page.title,
      description: page.description,
      path: pageUrl(slugs),
    };
  }
  const { catalog, icons } = sources;
  const [section, id, ...rest] = slugs;
  if (rest.length > 0) return null;
  if (section === "apps" && id === undefined) {
    return {
      kind: "apps",
      title: `${catalog.apps.length} apps, ready to install`,
      description: appsPageDescription,
      apps: listed(catalog.apps, icons),
      path: appsPath,
    };
  }
  if (id === undefined) return null;
  if (section === "apps" || section === "install") {
    const app = catalog.apps.find((candidate) => candidate.slug === id);
    if (app === undefined) return null;
    return section === "apps"
      ? {
          kind: "app",
          app: cardApp(app, icons),
          categories: app.categories.map(categoryLabel),
          path: appPath(app.slug),
        }
      : { kind: "install", app: cardApp(app, icons), path: installPath(app.slug) };
  }
  if (section === "categories") {
    const category = catalog.categories.find((candidate) => candidate.id === id);
    if (category === undefined) return null;
    const apps = catalog.apps.filter((app) => app.categories.includes(category.id));
    const count = apps.length === 1 ? "1 app" : `${apps.length} apps`;
    return {
      kind: "category",
      id: category.id,
      title: `${category.label} apps`,
      description: `${count} you can add to your own Cloudflare account with Appflare, each running under your control.`,
      apps: listed(apps, icons),
      path: categoryPath(category.id),
    };
  }
  return null;
}
