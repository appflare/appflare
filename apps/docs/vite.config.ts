import { globSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { getSlugs } from "fumadocs-core/source";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { defineConfig } from "vite";
import { ogImages } from "./src/build/og-images.ts";
import { markdownUrl, pageUrl, searchIndexPath, siteUrl } from "./src/lib/shared.ts";
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
 * The site is prerendered in full and served as static assets: `vite build`
 * writes every page as `<path>/index.html` plus its `.md` Markdown, `llms.txt`,
 * `llms-full.txt`, the search index at `/api/search.json`, `sitemap.xml`, `404.html`,
 * and one OpenGraph image per page, all into `dist/client`. The server bundle
 * in `dist/server` exists only to prerender; nothing is deployed from it.
 */
export default defineConfig({
  plugins: [
    manifestReference(),
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      prerender: {
        enabled: true,
        // Also follows every link the pages contain, so a page reachable only
        // through a link is still written.
        crawlLinks: true,
        // A link to a heading is the same page.
        filter: ({ path }) => !path.includes("#"),
        failOnError: true,
      },
      pages: [
        { path: "/404", prerender: { outputPath: "/404.html" } },
        { path: "/llms.txt" },
        { path: "/llms-full.txt" },
        { path: "/sitemap.xml" },
        { path: searchIndexPath },
        ...contentSlugs().flatMap((slugs) => [
          { path: pageUrl(slugs) },
          { path: markdownUrl(slugs) },
        ]),
      ],
      // TanStack Start's own sitemap lists every prerendered file, the Markdown
      // and text files included; `sitemap.xml` is a route instead, listing pages.
      sitemap: { enabled: false },
    }),
    react(),
    ogImages({ siteUrl }),
  ],
});
