import { type SigningKey, signingKeys } from "@appflare/schema";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { type CatalogKind, catalogs } from "../db/schema";
import { DEFAULT_CATALOG_INDEX_URL } from "./index.server";
import {
  CATALOG_COLOURS,
  type CatalogColour,
  type CatalogSource,
  OFFICIAL_CATALOG_ID,
} from "./sources";

/**
 * The catalogs this manager knows (`catalogs` table): the official one and
 * the custom ones admins added, each with the public keys it was added with.
 * The official catalog is always there: its row is written the first time
 * something about it is stored (turned off, refreshed), and reads use the
 * built-in record until then.
 *
 * Trust is per catalog. The official catalog's releases verify with the keys
 * built into Appflare (`signingKeys`), never with a stored row, so a key an
 * admin pasted can never verify an official release. A custom catalog's
 * releases and revised catalog manifests verify with its own pinned keys
 * only, so the official keys never verify a custom catalog's apps either.
 */

export interface CatalogRecord {
  id: string;
  kind: CatalogKind;
  label: string;
  colour: CatalogColour;
  /** The stored index URL (for the official catalog, `CATALOG_INDEX_URL` may override it). */
  indexUrl: string;
  /** The pinned public keys; for the official catalog, the ones built into Appflare. */
  keys: SigningKey[];
  enabled: boolean;
  addedAt: Date;
  refreshedAt: Date | null;
  refreshError: string | null;
}

/**
 * How a catalog's releases are verified and cached: `signingKeys` are the
 * keys that verify them (undefined for the official catalog: the built-in
 * keys), `catalogId` names the KV caches of what was verified with them.
 */
export interface CatalogTrust {
  catalogId: string;
  signingKeys?: readonly SigningKey[];
}

/** The official catalog's trust: the keys built into Appflare. */
export const OFFICIAL_TRUST: CatalogTrust = { catalogId: OFFICIAL_CATALOG_ID };

const storedKeysSchema = z.array(
  z.object({ keyId: z.string().min(1), publicKeyBase64: z.string().min(1) }),
);

function parseKeys(json: string): SigningKey[] {
  try {
    const parsed = storedKeysSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function colourOf(value: string): CatalogColour {
  return (CATALOG_COLOURS as readonly string[]).includes(value)
    ? (value as CatalogColour)
    : "neutral";
}

function recordOf(row: typeof catalogs.$inferSelect): CatalogRecord {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    colour: colourOf(row.colour),
    indexUrl: row.index_url,
    // The official catalog's keys are the ones built into Appflare, whatever its row says.
    keys: row.kind === "official" ? [...signingKeys] : parseKeys(row.keys_json),
    enabled: row.enabled,
    addedAt: row.added_at,
    refreshedAt: row.refreshed_at,
    refreshError: row.refresh_error,
  };
}

/**
 * The official catalog as Appflare ships it, for a database without its row:
 * a fresh one, before anything about the catalog was stored.
 */
function seededOfficial(): CatalogRecord {
  return {
    id: OFFICIAL_CATALOG_ID,
    kind: "official",
    label: "Official",
    colour: "orange",
    indexUrl: DEFAULT_CATALOG_INDEX_URL,
    keys: [...signingKeys],
    enabled: true,
    addedAt: new Date(0),
    refreshedAt: null,
    refreshError: null,
  };
}

/** Every catalog, the official one first, then the others in the order they were added. */
export async function listCatalogRecords(db: Database): Promise<CatalogRecord[]> {
  const rows = await db.select().from(catalogs).orderBy(asc(catalogs.added_at));
  const records = rows.map(recordOf);
  const official = records.find((r) => r.kind === "official") ?? seededOfficial();
  return [official, ...records.filter((r) => r.kind !== "official")];
}

/** One catalog by id, or null. */
export async function readCatalogRecord(db: Database, id: string): Promise<CatalogRecord | null> {
  const [row] = await db.select().from(catalogs).where(eq(catalogs.id, id)).limit(1);
  if (row !== undefined) return recordOf(row);
  return id === OFFICIAL_CATALOG_ID ? seededOfficial() : null;
}

/** The catalog's source badge. */
export function sourceOf(record: CatalogRecord): CatalogSource {
  return {
    id: record.id,
    label: record.label,
    colour: record.colour,
    official: record.kind === "official",
  };
}

/** How the catalog's releases are verified: the built-in keys for the official one, else its own. */
export function trustOf(record: CatalogRecord): CatalogTrust {
  return record.kind === "official"
    ? OFFICIAL_TRUST
    : { catalogId: record.id, signingKeys: record.keys };
}

/** Why a job cannot verify releases of `catalogId` any more; the message is safe to show. */
export class CatalogTrustError extends Error {
  override name = "CatalogTrustError";
}

/**
 * The trust of `catalogId` (null or missing means the official catalog).
 * `official` replaces the built-in keys (tests only). Throws
 * {@link CatalogTrustError} when a custom catalog was removed.
 */
export async function catalogTrust(
  db: Database,
  catalogId: string | null | undefined,
  official?: readonly SigningKey[],
): Promise<CatalogTrust> {
  const id = catalogId ?? OFFICIAL_CATALOG_ID;
  if (id === OFFICIAL_CATALOG_ID) {
    return official === undefined ? OFFICIAL_TRUST : { ...OFFICIAL_TRUST, signingKeys: official };
  }
  const record = await readCatalogRecord(db, id);
  if (record === null) {
    throw new CatalogTrustError(
      `the catalog "${id}" this app comes from was removed from Appflare; add it again to install or update its apps`,
    );
  }
  return trustOf(record);
}

/**
 * Writes the official catalog's row as Appflare ships it unless it is
 * already there, so a change to the catalog (turning it off, a refresh) has
 * a row to land on. An existing row is left as it is.
 */
export async function ensureOfficialCatalogRow(db: Database, now: Date): Promise<void> {
  const official = seededOfficial();
  await db
    .insert(catalogs)
    .values({
      id: official.id,
      kind: official.kind,
      label: official.label,
      colour: official.colour,
      index_url: official.indexUrl,
      keys_json: JSON.stringify(official.keys),
      enabled: official.enabled,
      added_at: now,
    })
    .onConflictDoNothing({ target: catalogs.id });
}

/** Records how a catalog's last refresh went. */
export async function recordCatalogRefresh(
  db: Database,
  id: string,
  outcome: { at: Date; error: string | null },
): Promise<void> {
  if (id === OFFICIAL_CATALOG_ID) await ensureOfficialCatalogRow(db, outcome.at);
  await db
    .update(catalogs)
    .set({
      refreshed_at: outcome.error === null ? outcome.at : undefined,
      refresh_error: outcome.error,
    })
    .where(eq(catalogs.id, id));
}
