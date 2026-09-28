import { z } from "zod";

/**
 * The catalog's categories: a fixed list of ids, each with the label the
 * manager shows. A catalog manifest names one to {@link MAX_ENTRY_CATEGORIES}
 * of them. Only the tools that write a manifest hold it to the list
 * ({@link strictCatalogCategoriesSchema}); a manager reads plain strings, in
 * the catalog manifest and in the published index, so it still reads an
 * entry that names an id added after its release, or a custom catalog's own
 * id, and shows it under no category.
 *
 * This module imports nothing but zod: `catalog.ts` imports it, and the JSON
 * Schema export runs `catalog.ts` directly under Node's type stripping.
 */
export const CATALOG_CATEGORIES = [
  { id: "ai", label: "AI" },
  { id: "analytics", label: "Analytics" },
  { id: "bots", label: "Bots" },
  { id: "business", label: "Business" },
  { id: "chat", label: "Chat" },
  { id: "cms", label: "Websites and blogs" },
  { id: "community", label: "Community" },
  { id: "developer-tools", label: "Developer tools" },
  { id: "ecommerce", label: "E-commerce" },
  { id: "education", label: "Education" },
  { id: "email", label: "Email" },
  { id: "family", label: "Family" },
  { id: "files", label: "Files" },
  { id: "finance", label: "Finance" },
  { id: "games", label: "Games" },
  { id: "marketing", label: "Marketing" },
  { id: "media", label: "Media" },
  { id: "monitoring", label: "Monitoring" },
  { id: "networking", label: "Networking" },
  { id: "notes", label: "Notes" },
  { id: "notifications", label: "Notifications" },
  { id: "passwords", label: "Passwords" },
  { id: "privacy", label: "Privacy" },
  { id: "productivity", label: "Productivity" },
  { id: "remote-access", label: "Remote access" },
  { id: "scheduling", label: "Scheduling" },
  { id: "security", label: "Security" },
  { id: "sharing", label: "Sharing" },
  { id: "sync", label: "Sync" },
  { id: "utilities", label: "Utilities" },
] as const;

export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number]["id"];

/** The ids of {@link CATALOG_CATEGORIES}, in order. */
export const CATALOG_CATEGORY_IDS = CATALOG_CATEGORIES.map((c) => c.id) as [
  CatalogCategory,
  ...CatalogCategory[],
];

/** The most categories one entry may name. */
export const MAX_ENTRY_CATEGORIES = 3;

/** One category id of the fixed list. */
export const catalogCategorySchema = z.enum(CATALOG_CATEGORY_IDS);

/** Whether `id` is a category this version knows. */
export function isCatalogCategory(id: string): id is CatalogCategory {
  return (CATALOG_CATEGORY_IDS as readonly string[]).includes(id);
}

/** The label the manager shows for a category id, or null for an id this version does not know. */
export function categoryLabel(id: string): string | null {
  return CATALOG_CATEGORIES.find((c) => c.id === id)?.label ?? null;
}

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
