/**
 * The catalog's categories as people read them. A catalog manifest lists
 * category ids (`developer-tools`, `cms`); every place that shows one, the
 * manager's catalog and the public site alike, labels it here, so both use
 * the same words. The ids and labels are the fixed list in
 * `category-list.ts`, which has no Zod in it.
 */
import { CATALOG_CATEGORIES } from "../category-list";

export {
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_IDS,
  type CatalogCategory,
  isCatalogCategory,
} from "../category-list";

const LABELS: ReadonlyMap<string, string> = new Map(CATALOG_CATEGORIES.map((c) => [c.id, c.label]));

/** Words kept in capitals when a category without a label is spelled out from its id. */
const CATEGORY_WORDS: ReadonlyMap<string, string> = new Map([
  ["ai", "AI"],
  ["cms", "CMS"],
  ["dns", "DNS"],
  ["seo", "SEO"],
]);

/**
 * A category id as a label: the catalog's own label for an id of its list
 * (`ecommerce` → "E-commerce", `cms` → "Websites and blogs"). An id this
 * version does not know (a custom catalog's, or one added later) is spelled
 * out in sentence case, keeping known acronyms: `dns-tools` → "DNS tools".
 */
export function categoryLabel(category: string): string {
  const label = LABELS.get(category);
  if (label !== undefined) return label;
  const words = category.split(/[-_\s]+/).filter((w) => w.length > 0);
  return words
    .map((word, i) => {
      const known = CATEGORY_WORDS.get(word.toLowerCase());
      if (known !== undefined) return known;
      return i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}
