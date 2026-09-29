import { globSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { getSlugs } from "fumadocs-core/source";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite";
import { ogImages } from "./src/build/og-images.ts";
import { catalogData, loadCatalog, snapshotMode } from "./src/catalog/plugin.ts";
import { catalogPagePaths, handoffPagePaths } from "./src/catalog/urls.ts";
import { markdownUrl, pageUrl, SITE_URL, searchIndexPath } from "./src/lib/shared.ts";
import { docsScreenshots } from "./src/og/plugin.ts";
import { manifestReference, referencePage } from "./src/reference/integration.ts";

/**
 * Every content page, found the way Fumadocs finds them, plus the generated
 * manifest reference (written when Vite starts, so it may not exist yet).
 */
function contentSlugs(): string[][] {
  const files = new Set(globSync("**/*.{md,mdx}", { cwd: "content/docs" }));
  files.add(referencePage.slice("content/docs/".length));
  return [...files].map((file) => getSlugs(file));
}

/**
 * Workspace packages list a custom `@appflare/source` export condition first,
 * pointing at their TypeScript source (see the root tsconfig.json), so the
 * pages use `@appflare/schema` as it is in the repository. This file itself
 * is loaded by Node, which reads the package's build instead: the catalog
 * step below needs `@appflare/schema` built first, as `turbo run build` does.
 */
const SOURCE_CONDITION = "@appflare/source";

/**
 * The site is prerendered in full and served as static assets: `vite build`
 * writes the front page, every docs page as `<path>/index.html` plus its `.md`
 * Markdown, `llms.txt`,
 * `llms-full.txt`, the search index at `/api/search.json`, `sitemap.xml`, `404.html`,
 * the catalog's pages (`/apps/`, one per app, one per category), the pages
 * that pass a visitor on to their own Appflare (`/install/<slug>/`,
 * `/install/`, `/my/`), and one
 * OpenGraph image per page, all into `dist/client`. The server bundle in
 * `dist/server` exists only to prerender; nothing is deployed from it.
 *
 * The catalog comes from the published catalog with `CATALOG_SNAPSHOT=live`
 * (the deploy workflow), else from the checked-in snapshot.
 */
export default defineConfig(async () => {
  const catalog = await loadCatalog(snapshotMode(process.env.CATALOG_SNAPSHOT));
  return {
    resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
    environments: {
      ssr: { resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] } },
    },
    plugins: [
      catalogData(catalog),
      docsScreenshots(),
      manifestReference(),
      fumadocsMdx(),
      tailwindcss(),
      tanstackStart({
        prerender: {
          enabled: true,
          // Also follows every link the pages contain, so a page reachable only
          // through a link is still written.
          crawlLinks: true,
          // A link to a heading is the same page, and a query (an install link
          // for a repository, `/install/?repo=`) is read by the page in the browser.
          filter: ({ path }) => !path.includes("#") && !path.includes("?"),
          failOnError: true,
        },
        pages: [
          { path: "/" },
          { path: "/404", prerender: { outputPath: "/404.html" } },
          { path: "/llms.txt" },
          { path: "/llms-full.txt" },
          { path: "/sitemap.xml" },
          { path: searchIndexPath },
          ...contentSlugs().flatMap((slugs) => [
            { path: pageUrl(slugs) },
            { path: markdownUrl(slugs) },
          ]),
          ...catalogPagePaths(catalog.site).map((path) => ({ path })),
          ...handoffPagePaths(catalog.site).map((path) => ({ path })),
        ],
        // TanStack Start's own sitemap lists every prerendered file, the Markdown
        // and text files included; `sitemap.xml` is a route instead, listing pages.
        sitemap: { enabled: false },
      }),
      react(),
      ogImages({ siteUrl: SITE_URL }),
    ],
  };
});
