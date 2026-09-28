import { z } from "zod";

/**
 * The catalog's categories: a fixed list of ids, each with the label the
 * manager shows. A catalog manifest names one to {@link MAX_ENTRY_CATEGORIES}
 * of them. The published index keeps them as plain strings, so a manager
 * still reads a custom catalog that uses an id it does not know (it shows
 * such an entry under no category).
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

/** One category id. */
export const catalogCategorySchema = z.enum(CATALOG_CATEGORY_IDS);

/** Whether `id` is a category this version knows. */
export function isCatalogCategory(id: string): id is CatalogCategory {
  return (CATALOG_CATEGORY_IDS as readonly string[]).includes(id);
}

/** The label the manager shows for a category id, or null for an id this version does not know. */
export function categoryLabel(id: string): string | null {
  return CATALOG_CATEGORIES.find((c) => c.id === id)?.label ?? null;
}

/** A catalog manifest's `categories`: one to three ids, each once. */
export const catalogCategoriesSchema = z
  .array(catalogCategorySchema)
  .min(1)
  .max(MAX_ENTRY_CATEGORIES)
  .refine((ids) => new Set(ids).size === ids.length, "a category is listed twice")
  .meta({
    uniqueItems: true,
    description:
      `One to ${MAX_ENTRY_CATEGORIES} categories the catalog lists the app under, each once: ` +
      CATALOG_CATEGORIES.map((c) => `\`${c.id}\` (${c.label})`).join(", ") +
      ".",
  });
