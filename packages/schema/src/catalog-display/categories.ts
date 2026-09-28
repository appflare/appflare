/**
 * The catalog's categories as people read them. A catalog manifest lists
 * category ids (`developer-tools`, `cms`); every place that shows one, the
 * manager's catalog and the public site alike, labels it here, so both use
 * the same words.
 */

/** The label of every category the catalog uses, written as a person would write it. */
const CATEGORY_LABELS = {
  ai: "AI",
  analytics: "Analytics",
  bots: "Bots",
  business: "Business",
  chat: "Chat",
  cms: "Websites and blogs",
  community: "Community",
  "developer-tools": "Developer tools",
  dns: "DNS",
  ecommerce: "E-commerce",
  education: "Education",
  email: "Email",
  family: "Family",
  files: "Files",
  finance: "Finance",
  games: "Games",
  "link-shortener": "Link shortener",
  marketing: "Marketing",
  media: "Media",
  monitoring: "Monitoring",
  networking: "Networking",
  notes: "Notes",
  notifications: "Notifications",
  passwords: "Passwords",
  privacy: "Privacy",
  productivity: "Productivity",
  "remote-access": "Remote access",
  scheduling: "Scheduling",
  security: "Security",
  sharing: "Sharing",
  sync: "Sync",
  utilities: "Utilities",
} as const satisfies Readonly<Record<string, string>>;

/** A category the catalog has a label for. */
export type CategoryId = keyof typeof CATEGORY_LABELS;

/** Every category the catalog has a label for, in alphabetical order of id. */
export const CATEGORY_IDS = Object.keys(CATEGORY_LABELS) as CategoryId[];

/**
 * Categories the catalog folded into another, each with the one it became. An
 * older index or another catalog may still list the old slug; it counts,
 * filters and reads as its target, so a page never shows two entries for one
 * category.
 */
const FOLDED_CATEGORIES: Readonly<Record<string, CategoryId>> = {
  blogging: "cms",
  gaming: "games",
  social: "community",
  storage: "files",
};

/** The category a slug stands for: the target of a folded category, any other slug itself. */
export function canonicalCategory(category: string): string {
  return Object.hasOwn(FOLDED_CATEGORIES, category)
    ? (FOLDED_CATEGORIES[category] ?? category)
    : category;
}

/** Words kept in capitals when a category without a label is spelled out from its slug. */
const CATEGORY_WORDS: Readonly<Record<string, string>> = {
  ai: "AI",
  cms: "CMS",
  dns: "DNS",
  seo: "SEO",
};

function isCategoryId(category: string): category is CategoryId {
  return Object.hasOwn(CATEGORY_LABELS, category);
}

/**
 * A category slug as a label: `ecommerce` → "E-commerce", `developer-tools` →
 * "Developer tools", a folded category as the one it became. A category
 * without a label of its own is spelled out from its slug in sentence case,
 * keeping known acronyms: `dns-tools` → "DNS tools".
 */
export function categoryLabel(category: string): string {
  const canonical = canonicalCategory(category);
  if (isCategoryId(canonical)) return CATEGORY_LABELS[canonical];
  const words = category.split(/[-_\s]+/).filter((w) => w.length > 0);
  return words
    .map((word, i) => {
      const known = CATEGORY_WORDS[word.toLowerCase()];
      if (known !== undefined) return known;
      return i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}
