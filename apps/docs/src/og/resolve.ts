import { categoryLabel, comparePopularity } from "@appflare/schema/catalog-display";
import type { Node as PageTreeNode, Root as PageTreeRoot } from "fumadocs-core/page-tree";
import type { SiteApp, SiteCatalog } from "../catalog/site-catalog.ts";
import { appPath, appsPath, categoryPath, installPath } from "../catalog/urls.ts";
import { pageUrl } from "../lib/shared.ts";
import { type CardApp, DASHBOARD, type DocsPicture, type OgCard } from "./cards.tsx";
import type { OgPicture } from "./picture.ts";

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

/** The site card's words: the front page's promise, in the words the front page uses. */
export const siteCardText = {
  title: "The app manager for your own Cloudflare account",
  description:
    "One Worker in your account installs apps built for Workers and keeps them updated, with a rollback when you need one.",
} as const;

/** A docs page as the cards read it. */
export interface CardPage {
  title: string;
  description?: string | undefined;
  url: string;
  /** The address of the first screenshot the page shows (`/screenshots/<name>.png`), if any. */
  screenshot: string | null;
}

/** What {@link ogCardFor} reads: the docs pages, the catalog, and the pictures. */
export interface CardSources {
  /** A docs page by its slugs. */
  page(slugs: string[]): CardPage | null;
  /** The docs page tree, for the heading a page is listed under. */
  tree: PageTreeRoot;
  catalog: Pick<SiteCatalog, "apps" | "categories">;
  /** App icons as data URIs, by slug. */
  icons: Readonly<Record<string, string>>;
  /** Each app's first screenshot, by slug. */
  appScreenshots: Readonly<Record<string, OgPicture>>;
  /** The docs' screenshots, by their address on the site. */
  docsScreenshots: Readonly<Record<string, OgPicture>>;
}

/** The address of the first of the docs' screenshots a page's Markdown shows, or null. */
export function firstScreenshot(markdown: string): string | null {
  return /(\/screenshots\/[\w.-]+\.png)\b/.exec(markdown)?.[1] ?? null;
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

const count = (n: number) => (n === 1 ? "1 app" : `${n} apps`);

/** The card an OpenGraph image path's slugs draw, or null when they name nothing. */
export function ogCardFor(slugs: readonly string[], sources: CardSources): OgCard | null {
  const { catalog, icons, appScreenshots, docsScreenshots } = sources;
  const docsPicture = (path: string | null): DocsPicture | null => {
    const picture = path === null ? undefined : docsScreenshots[path];
    return path === null || picture === undefined ? null : { path, picture };
  };
  if (slugs.length === 0) {
    return { kind: "site", ...siteCardText, dashboard: docsScreenshots[DASHBOARD] ?? null };
  }
  const page = sources.page([...slugs]);
  if (page !== null) {
    return {
      kind: "docs",
      section: docsSection(sources.tree, page.url),
      title: page.title,
      description: page.description,
      path: pageUrl(slugs),
      screenshot: docsPicture(page.screenshot) ?? docsPicture(DASHBOARD),
    };
  }
  const [section, id, ...rest] = slugs;
  if (rest.length > 0) return null;
  if (section === "apps" && id === undefined) {
    return {
      kind: "apps",
      title: `${count(catalog.apps.length)} for your Cloudflare account`,
      description: "Each one installs with Appflare and runs in your account, under your control.",
      apps: listed(catalog.apps, icons),
      path: appsPath,
    };
  }
  if (id === undefined) return null;
  if (section === "apps" || section === "install") {
    const app = catalog.apps.find((candidate) => candidate.slug === id);
    if (app === undefined) return null;
    const screenshot = appScreenshots[app.slug] ?? null;
    return section === "apps"
      ? {
          kind: "app",
          app: cardApp(app, icons),
          categories: app.categories.map(categoryLabel),
          path: appPath(app.slug),
          screenshot,
        }
      : { kind: "install", app: cardApp(app, icons), path: installPath(app.slug), screenshot };
  }
  if (section === "categories") {
    const category = catalog.categories.find((candidate) => candidate.id === id);
    if (category === undefined) return null;
    const apps = catalog.apps.filter((app) => app.categories.includes(category.id));
    return {
      kind: "category",
      title: category.label,
      description: `${count(apps.length)} you can add to your own Cloudflare account with Appflare.`,
      apps: listed(apps, icons),
      path: categoryPath(category.id),
    };
  }
  return null;
}
