/**
 * The catalog's categories: a fixed list of ids, each with the label people
 * see, the same in the manager and on the public site. A catalog manifest
 * names one to {@link MAX_ENTRY_CATEGORIES} of them.
 *
 * No imports at all: `categories.ts` builds the Zod schemas on this list
 * (and `catalog.ts`, which the JSON Schema export runs under Node's type
 * stripping, imports that), and the catalog display helpers read it in a
 * browser bundle without Zod.
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

/** Whether `id` is a category this version knows. */
export function isCatalogCategory(id: string): id is CatalogCategory {
  return (CATALOG_CATEGORY_IDS as readonly string[]).includes(id);
}
