import { siteName } from "./shared.ts";

export interface PageMeta {
  /** The document title. */
  title: string;
  description?: string | undefined;
  /** Absolute canonical URL of the page. */
  url: string;
  /** Absolute URL of the page's OpenGraph image. */
  image: string;
}

/**
 * The `<head>` entries of a docs page: title, description, canonical link, and
 * the OpenGraph and Twitter card tags that point at the page's generated image.
 */
export function pageHead({ title, description, url, image }: PageMeta) {
  const meta: Array<Record<string, string>> = [
    { title },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: siteName },
    { property: "og:title", content: title },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:image", content: image },
  ];
  if (description) {
    meta.push(
      { name: "description", content: description },
      { property: "og:description", content: description },
      { name: "twitter:description", content: description },
    );
  }
  return { meta, links: [{ rel: "canonical", href: url }] };
}
