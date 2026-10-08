import { siteName } from "./shared.ts";
import type { StructuredData } from "./structured-data.ts";

export interface PageMeta {
  /** The document title. */
  title: string;
  description?: string | undefined;
  /** Absolute canonical URL of the page. */
  url: string;
  /** Absolute URL of the page's OpenGraph image, a 1200x630 PNG. */
  image: string;
  /** Site-relative URL of the page as Markdown, linked as its `text/markdown` alternate. */
  markdownUrl?: string | undefined;
  /** schema.org data about the page, written as a JSON-LD script. */
  structuredData?: StructuredData | undefined;
}

/**
 * The `<head>` entries of a docs page: title, description, canonical link, and
 * the OpenGraph and Twitter card tags that point at the page's generated image,
 * and, when given, the page's Markdown alternate and its JSON-LD.
 */
export function pageHead({
  title,
  description,
  url,
  image,
  markdownUrl,
  structuredData,
}: PageMeta) {
  const meta: Array<Record<string, string>> = [
    { title },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: siteName },
    { property: "og:title", content: title },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    { property: "og:image:type", content: "image/png" },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: title },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:image", content: image },
    { name: "twitter:image:alt", content: title },
  ];
  if (description) {
    meta.push(
      { name: "description", content: description },
      { property: "og:description", content: description },
      { name: "twitter:description", content: description },
    );
  }
  const links: Array<Record<string, string>> = [{ rel: "canonical", href: url }];
  if (markdownUrl) links.push({ rel: "alternate", type: "text/markdown", href: markdownUrl });
  // App data comes from the catalog, so `<` is escaped: no text can close the script.
  const scripts = structuredData
    ? [
        {
          type: "application/ld+json",
          children: JSON.stringify(structuredData).replaceAll("<", "\\u003c"),
        },
      ]
    : [];
  return { meta, links, scripts };
}

/**
 * The `<head>` of a page search engines should leave out (the install pages
 * and `/my/`, which only pass a visitor on): {@link pageHead} plus `noindex`.
 */
export function noindexPageHead(page: PageMeta) {
  const head = pageHead(page);
  return { ...head, meta: [...head.meta, { name: "robots", content: "noindex" }] };
}
