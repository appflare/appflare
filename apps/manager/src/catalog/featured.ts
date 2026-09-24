import { type FeaturedItem, isFeaturedItemActive } from "@appflare/schema";
import { mediaSrc } from "./media";

/**
 * The catalog's sponsored slot. The index may list several items; the
 * catalog page shows one at a time: the first, in index order, that is inside
 * its time window and that the user has not hidden. It is never shown
 * anywhere else, never changes search, sort or popularity, and nothing about
 * it (views, clicks, hides) leaves the manager.
 */

/** What the catalog page renders for the sponsored item. */
export interface FeaturedCard {
  id: string;
  title: string;
  text: string;
  sponsorName: string;
  /** The sponsor's own site, when given. */
  sponsorUrl: string | null;
  /** Manager path of the image; null when there is none or it is not on the catalog site. */
  image: { src: string; alt: string } | null;
  link: { url: string; label: string } | null;
  /** The catalog app the item promotes, when it promotes one. */
  app: { slug: string; name: string } | null;
}

/** The item to show, or null: the first active one the user has not hidden. */
export function pickFeatured(
  items: readonly FeaturedItem[],
  dismissed: ReadonlySet<string>,
  now: Date,
): FeaturedItem | null {
  return items.find((item) => !dismissed.has(item.id) && isFeaturedItemActive(item, now)) ?? null;
}

/**
 * The card for `item`. `appName` names the promoted app (from the index);
 * an item promoting an app the index does not list keeps only its link.
 */
export function featuredCard(
  item: FeaturedItem,
  indexUrl: string,
  appName: (slug: string) => string | null,
): FeaturedCard {
  const name = item.slug === undefined ? null : appName(item.slug);
  const src = mediaSrc(item.image, indexUrl);
  return {
    id: item.id,
    title: item.title,
    text: item.text,
    sponsorName: item.sponsor.name,
    sponsorUrl: item.sponsor.url ?? null,
    image: src === null || item.image === undefined ? null : { src, alt: item.image.alt },
    link: item.link ?? null,
    app: item.slug === undefined || name === null ? null : { slug: item.slug, name },
  };
}

/**
 * Where a link to sponsor content may go: an https URL, used exactly as
 * published (nothing is ever appended to it).
 */
export function safeExternalUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
