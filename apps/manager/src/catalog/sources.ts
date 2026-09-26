import { z } from "zod";

/**
 * The catalogs an app can come from, as the pages name them. Client-safe.
 *
 * Apps are addressed by an app key: the official catalog's apps by their
 * plain slug (`cut`), so every link and record from before there were other
 * catalogs keeps working, and a custom catalog's apps by `<catalogId>:<slug>`
 * (`acme:cut`), so two catalogs may list the same slug without one ever
 * standing in for the other. The key is only an address: installs record the
 * catalog id and the plain slug separately.
 */

/** The catalog Appflare ships with. */
export const OFFICIAL_CATALOG_ID = "official";

/** Most custom catalogs a manager takes: the cron fetches every enabled index each run. */
export const MAX_CUSTOM_CATALOGS = 5;

/** Kumo badge colours a catalog's source badge may use. */
export const CATALOG_COLOURS = [
  "orange",
  "blue",
  "green",
  "purple",
  "teal",
  "red",
  "neutral",
] as const;
export type CatalogColour = (typeof CATALOG_COLOURS)[number];

export const CATALOG_COLOUR_LABELS: Record<CatalogColour, string> = {
  orange: "Orange",
  blue: "Blue",
  green: "Green",
  purple: "Purple",
  teal: "Teal",
  red: "Red",
  neutral: "Grey",
};

/** A catalog as the pages show it: its source badge. */
export interface CatalogSource {
  id: string;
  label: string;
  colour: CatalogColour;
  official: boolean;
}

/**
 * Why an added catalog's `sandbox` or `self-deploying` entry is refused. Only
 * a prebuilt release is signed; those tiers are trusted by what the index
 * says, and an added catalog's index is not signed yet (signing the index is
 * what would let them in).
 */
export const UNSIGNED_INDEX_REFUSAL =
  "This catalog's index is not signed; only prebuilt releases are installed from added catalogs.";

/** {@link UNSIGNED_INDEX_REFUSAL} for an entry of `tier` in `catalogId`, else null. */
export function unsignedTierRefusal(
  catalogId: string | null | undefined,
  tier: string,
): string | null {
  return (catalogId ?? OFFICIAL_CATALOG_ID) !== OFFICIAL_CATALOG_ID && tier !== "artifact"
    ? UNSIGNED_INDEX_REFUSAL
    : null;
}

/** Ids an added catalog may not take: the official one's, and the prefix of repository installs. */
const RESERVED_IDS: ReadonlySet<string> = new Set([OFFICIAL_CATALOG_ID, "repository"]);

/** A custom catalog's id: lowercase letters, digits and dashes, at most 24. */
export const customCatalogIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,23}$/, "must be lowercase letters, digits and dashes")
  .refine((id) => !RESERVED_IDS.has(id), "is reserved");

export const catalogLabelSchema = z
  .string()
  .trim()
  .min(1, "Enter a label.")
  .max(40, "Use at most 40 characters.");

export const catalogColourSchema = z.enum(CATALOG_COLOURS);

/**
 * An index URL an admin may add: https only, no credentials in it, and not
 * longer than a URL needs to be.
 */
export const catalogIndexUrlSchema = z
  .string()
  .trim()
  .max(500, "Use a shorter URL.")
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "Enter an https:// URL of the catalog's index.json.");

/**
 * A new catalog's id from its label: its words in lowercase joined by
 * dashes, with `-2`, `-3`, ... when `taken` holds it already.
 */
export function catalogIdFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20)
      .replace(/-+$/, "") || "catalog";
  const free = (id: string) => !taken.has(id) && customCatalogIdSchema.safeParse(id).success;
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (free(id)) return id;
  }
}

/** The app key of `slug` in `catalogId` (see the module comment). */
export function appKey(catalogId: string | null | undefined, slug: string): string {
  const id = catalogId ?? OFFICIAL_CATALOG_ID;
  if (id !== OFFICIAL_CATALOG_ID) return `${id}:${slug}`;
  // An official slug never holds a colon; if one did, spell its catalog out.
  return slug.includes(":") ? `${OFFICIAL_CATALOG_ID}:${slug}` : slug;
}

/** The catalog and slug an app key names; a key without a catalog prefix is the official catalog's. */
export function parseAppKey(key: string): { catalogId: string; slug: string } {
  const colon = key.indexOf(":");
  if (colon > 0) {
    const prefix = key.slice(0, colon);
    if (prefix === OFFICIAL_CATALOG_ID || customCatalogIdSchema.safeParse(prefix).success) {
      return { catalogId: prefix, slug: key.slice(colon + 1) };
    }
  }
  return { catalogId: OFFICIAL_CATALOG_ID, slug: key };
}

/** The app key of an install row, or its plain slug for an install from a repository. */
export function installAppKey(row: { app_slug: string; catalog_id: string | null }): string {
  return row.catalog_id === null ? row.app_slug : appKey(row.catalog_id, row.app_slug);
}
