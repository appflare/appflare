import { llms, loader } from "fumadocs-core/source";
import { applyMdxPreset } from "fumadocs-mdx/config";
import { defineDocs } from "fumadocs-mdx/macro";
import { formatPageMarkdown } from "./llms-format.ts";
import { filterForAgents, stringifyForAgents } from "./llms-stringify.ts";
import { pageUrl, SITE_URL } from "./shared.ts";

/**
 * Every page under `content/docs`, compiled by Fumadocs MDX at build time.
 * `async` keeps each page's body out of the main bundle until it is visited.
 * The processed Markdown of each page feeds `llms-full.txt` and the per-page
 * `.md` files.
 *
 * Images on other sites, such as Cloudflare's Deploy button, are left as
 * written. By default the compiler downloads each one to read its size, so a
 * slow or failed download failed the build; an image in `public/` is still
 * sized from its file.
 */
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    async: true,
    mdxOptions: applyMdxPreset({ remarkImageOptions: { external: false } }),
    postprocess: {
      includeProcessedMarkdown: {
        headingIds: false,
        filterElement: filterForAgents,
        stringify: stringifyForAgents,
      },
    },
  },
});

/**
 * The page tree and page lookup. Fumadocs gives each page a URL without a
 * trailing slash (`page.url`); the site's canonical URLs have one, so absolute
 * links are built with `pageUrl(page.slugs)` instead.
 */
export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: "/",
});

export type DocsPage = (typeof source)["$inferPage"];

/** Each page's `.md` file, and all of them joined as `llms-full.txt`. */
export const docsLlms = llms(source, {
  renderPage: async (page) =>
    formatPageMarkdown({
      title: page.data.title,
      description: page.data.description,
      url: `${SITE_URL}${pageUrl(page.slugs)}`,
      content: await page.data.getText("processed"),
    }),
});
