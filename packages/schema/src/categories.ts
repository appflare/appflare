import { z } from "zod";
// With its extension: the JSON Schema export runs catalog.ts, which imports
// this file, under Node's type stripping.
import {
  CATALOG_CATEGORIES,
  CATALOG_CATEGORY_IDS,
  isCatalogCategory,
  MAX_ENTRY_CATEGORIES,
} from "./category-list.ts";

/**
 * The Zod side of the catalog's categories ({@link CATALOG_CATEGORIES}, in
 * `category-list.ts`). A catalog manifest names one to
 * {@link MAX_ENTRY_CATEGORIES} of them. Only the tools that write a manifest
 * hold it to the list ({@link strictCatalogCategoriesSchema}); a manager
 * reads plain strings, in the catalog manifest and in the published index,
 * so it still reads an entry that names an id added after its release, or a
 * custom catalog's own id, and shows it under no category. The label of an
 * id is `categoryLabel` in the catalog display helpers.
 */
export * from "./category-list.ts";

/** One category id of the fixed list. */
export const catalogCategorySchema = z.enum(CATALOG_CATEGORY_IDS);

/** A problem with a list of categories, with its path inside the list. */
export interface CategoryProblem {
  path: Array<string | number>;
  message: string;
}

/**
 * What is wrong with `categories` beyond what {@link catalogCategoriesSchema}
 * checks: an id that is not on the list, or one listed twice. Values of the
 * wrong type are left to that schema.
 */
export function catalogCategoryProblems(categories: unknown): CategoryProblem[] {
  if (!Array.isArray(categories)) return [];
  const problems: CategoryProblem[] = [];
  const seen = new Set<string>();
  categories.forEach((id: unknown, i) => {
    if (typeof id !== "string" || id === "") return;
    if (!isCatalogCategory(id)) {
      problems.push({
        path: [i],
        message: `"${id}" is not a category; use one of ${CATALOG_CATEGORY_IDS.join(", ")}`,
      });
    }
    if (seen.has(id)) problems.push({ path: [i], message: `the category "${id}" is listed twice` });
    seen.add(id);
  });
  return problems;
}

/**
 * A catalog manifest's `categories` as a manager reads it: one to
 * {@link MAX_ENTRY_CATEGORIES} plain strings. A manager does not hold them to
 * its own list, so it never refuses an artifact or a revised manifest over a
 * category added after its release. The JSON Schema states the list, since
 * it describes what an author writes.
 */
export const catalogCategoriesSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_ENTRY_CATEGORIES)
  .meta({
    uniqueItems: true,
    items: { type: "string", enum: [...CATALOG_CATEGORY_IDS] },
    description:
      `One to ${MAX_ENTRY_CATEGORIES} categories the catalog lists the app under, each once: ` +
      CATALOG_CATEGORIES.map((c) => `\`${c.id}\` (${c.label})`).join(", ") +
      ".",
  });

/**
 * `categories` as the tools that write a manifest check it: one to
 * {@link MAX_ENTRY_CATEGORIES} ids of {@link CATALOG_CATEGORIES}, each once.
 */
export const strictCatalogCategoriesSchema = catalogCategoriesSchema.superRefine(
  (categories, ctx) => {
    for (const problem of catalogCategoryProblems(categories)) {
      ctx.addIssue({ code: "custom", path: problem.path, message: problem.message });
    }
  },
);
