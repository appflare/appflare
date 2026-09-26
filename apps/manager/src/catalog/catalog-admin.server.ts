import type { FetchLike } from "@appflare/cf-api";
import {
  decodePublicKey,
  type IndexApp,
  indexAppArtifact,
  PublicKeyFormatError,
  parsePublicKeys,
  type SigningKey,
  signingKeys,
} from "@appflare/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { catalogs, installs } from "../db/schema";
import { installLabel } from "../installs/display-name";
import {
  ArtifactError,
  ArtifactFetchError,
  fetchWhole,
  verifyArtifactManifest,
} from "../jobs/install/artifact";
import { listCatalogRecords, readCatalogRecord } from "./catalogs.server";
import { fetchCatalogJson } from "./conditional-fetch";
import {
  CatalogError,
  cacheCustomCatalogIndex,
  catalogIndexUrl,
  forgetCustomCatalogCaches,
  type ParsedCatalogIndex,
  parseCatalogIndex,
} from "./index.server";
import {
  type CatalogColour,
  catalogColourSchema,
  catalogIdFromLabel,
  catalogIndexUrlSchema,
  catalogLabelSchema,
  MAX_CUSTOM_CATALOGS,
} from "./sources";

/**
 * Adding, editing, turning off and removing catalogs (Settings, Catalogs).
 *
 * A custom catalog is added only once it has proven itself: its index is
 * fetched and must be a valid catalog index, and the signed `manifest.json`
 * of one of its releases must verify with the public keys the admin pasted
 * (the digest the index lists, the app and version it names). Only then is
 * it stored, with those keys pinned. Editing its URL or keys checks again.
 * The official catalog can only be turned off and on.
 */

/** Why a catalog change was refused; the message is safe to show. */
export class CatalogAdminError extends Error {
  override name = "CatalogAdminError";
}

export interface CatalogAdminDeps {
  db: D1Database;
  kv: KVNamespace;
  /** `CATALOG_INDEX_URL`, which moves the official catalog's index (development). */
  officialIndexUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

export interface CatalogInput {
  indexUrl: string;
  /** The public keys as pasted (`parsePublicKeys`). */
  publicKeys: string;
  label: string;
  colour: CatalogColour;
}

/** What {@link checkCatalog} proved. */
export interface CheckedCatalog {
  index: ParsedCatalogIndex;
  etag: string | null;
  /** The release whose signed manifest verified with the keys. */
  checked: { slug: string; version: string; keyId: string };
}

/** The release a catalog is checked with: the first entry that has one. */
function firstRelease(apps: readonly IndexApp[]) {
  for (const app of apps) {
    const release = indexAppArtifact(app);
    if (app.tier === "artifact" && release !== null) return { app, release };
  }
  return null;
}

/**
 * Fetches the index at `url`, checks that it is a catalog index, and
 * verifies one release's signed manifest with `keys`. At most five
 * requests (the index, then the manifest and its signature, each through a
 * release redirect). Throws {@link CatalogAdminError}.
 */
export async function checkCatalog(
  fetchImpl: FetchLike,
  url: string,
  keys: readonly SigningKey[],
): Promise<CheckedCatalog> {
  let fetched: Awaited<ReturnType<typeof fetchCatalogJson>>;
  try {
    fetched = await fetchCatalogJson(fetchImpl, url, null, "catalog");
  } catch (error) {
    if (error instanceof CatalogError) throw new CatalogAdminError(error.message);
    throw error;
  }
  if (fetched.status !== "ok") {
    throw new CatalogAdminError(`The catalog at ${url} answered 304 to a plain request.`);
  }
  const index = parseCatalogIndex(fetched.json);
  if (index === null) {
    throw new CatalogAdminError(
      `${url} is not a catalog index: it needs "generatedAt" and an "apps" list.`,
    );
  }
  const found = firstRelease(index.index.apps);
  if (found === null) {
    throw new CatalogAdminError(
      index.index.apps.length === 0
        ? "The catalog lists no apps yet, so its key cannot be checked. Add it once it has released one."
        : "The catalog lists no signed release, so its key cannot be checked. Add it once it has released one.",
    );
  }
  const { app, release } = found;
  try {
    const [manifest, sig] = await Promise.all([
      fetchWhole(fetchImpl, release.artifacts.manifest),
      fetchWhole(fetchImpl, release.artifacts.sig),
    ]);
    const verified = await verifyArtifactManifest(
      manifest.bytes,
      new TextDecoder().decode(sig.bytes),
      { slug: app.slug, version: app.version, digest: release.digest },
      keys,
    );
    return {
      index,
      etag: fetched.etag,
      checked: { slug: app.slug, version: app.version, keyId: verified.keyId },
    };
  } catch (error) {
    if (error instanceof ArtifactError) {
      throw new CatalogAdminError(
        `The public key does not verify ${app.slug} ${app.version} from this catalog: ${error.message}.`,
      );
    }
    if (error instanceof ArtifactFetchError) {
      throw new CatalogAdminError(
        `Could not read the signed manifest of ${app.slug} ${app.version}: ${error.message}.`,
      );
    }
    throw error;
  }
}

/** Key ids Appflare verifies its own releases with; a pasted key may not reuse one. */
const BUILT_IN_KEY_IDS: ReadonlySet<string> = new Set(signingKeys.map((k) => k.keyId));

/** A key's raw bytes as canonical base64, so two spellings of one key compare equal. */
function rawKey(key: SigningKey): string {
  let binary = "";
  for (const byte of decodePublicKey(key)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The official public keys; a pasted key may not be one of them under any id. */
const BUILT_IN_KEYS: ReadonlySet<string> = new Set(signingKeys.map(rawKey));

/** The pasted keys, refused when unreadable or when one reuses a built-in key id. */
export function pastedKeys(text: string): SigningKey[] {
  let keys: SigningKey[];
  try {
    keys = parsePublicKeys(text);
  } catch (error) {
    if (error instanceof PublicKeyFormatError) throw new CatalogAdminError(error.message);
    throw error;
  }
  const reused = keys.find((k) => BUILT_IN_KEY_IDS.has(k.keyId));
  if (reused !== undefined) {
    throw new CatalogAdminError(
      `The key id "${reused.keyId}" belongs to the official catalog. A custom catalog signs with its own key id.`,
    );
  }
  const official = keys.find((k) => BUILT_IN_KEYS.has(rawKey(k)));
  if (official !== undefined) {
    throw new CatalogAdminError(
      `The key "${official.keyId}" is one of the official catalog's keys. A custom catalog signs with a key of its own.`,
    );
  }
  return keys;
}

function parseInput(input: CatalogInput) {
  const url = catalogIndexUrlSchema.safeParse(input.indexUrl);
  if (!url.success) throw new CatalogAdminError(url.error.issues[0]?.message ?? "Check the URL.");
  const label = catalogLabelSchema.safeParse(input.label);
  if (!label.success) {
    throw new CatalogAdminError(label.error.issues[0]?.message ?? "Check the label.");
  }
  const colour = catalogColourSchema.safeParse(input.colour);
  if (!colour.success) throw new CatalogAdminError("Choose one of the colours.");
  return {
    indexUrl: url.data,
    label: label.data,
    colour: colour.data,
    keys: pastedKeys(input.publicKeys),
  };
}

/** The keys as `keys_json` stores them, in the shape `signingKeys` has. */
function storedKeys(keys: readonly SigningKey[]): string {
  return JSON.stringify(keys.map(({ keyId, publicKeyBase64 }) => ({ keyId, publicKeyBase64 })));
}

/** The same index URL must not be listed twice: it would list every app twice. */
async function refuseDuplicateUrl(
  deps: CatalogAdminDeps,
  url: string,
  except: string | null,
): Promise<void> {
  const records = await listCatalogRecords(createDb(deps.db));
  const official = catalogIndexUrl({ CATALOG_INDEX_URL: deps.officialIndexUrl });
  const same = records.find(
    (r) => r.id !== except && (r.kind === "official" ? official : r.indexUrl) === url,
  );
  if (same !== undefined) {
    throw new CatalogAdminError(`${same.label} already uses this index URL.`);
  }
}

/** Adds a custom catalog once {@link checkCatalog} passed. Returns its id. */
export async function addCatalogCore(
  deps: CatalogAdminDeps,
  input: CatalogInput,
): Promise<{ id: string; checked: CheckedCatalog["checked"] }> {
  const parsed = parseInput(input);
  const db = createDb(deps.db);
  const full = () =>
    new CatalogAdminError(
      `Appflare takes at most ${MAX_CUSTOM_CATALOGS} added catalogs. Remove one first.`,
    );
  if (
    (await listCatalogRecords(db)).filter((r) => r.kind === "custom").length >= MAX_CUSTOM_CATALOGS
  ) {
    throw full();
  }
  await refuseDuplicateUrl(deps, parsed.indexUrl, null);
  const fetchImpl: FetchLike = deps.fetch ?? ((i, init) => fetch(i, init));
  const checked = await checkCatalog(fetchImpl, parsed.indexUrl, parsed.keys);
  const now = (deps.now ?? (() => new Date()))();
  const records = await listCatalogRecords(db);
  const id = catalogIdFromLabel(parsed.label, new Set(records.map((r) => r.id)));
  // One statement: the limit, the URL and the id are checked where the row is
  // written, so two admins adding at once cannot pass the limit together.
  const inserted = await deps.db
    .prepare(
      `INSERT INTO catalogs (id, kind, label, colour, index_url, keys_json, enabled, added_at,
         refreshed_at)
       SELECT ?1, 'custom', ?2, ?3, ?4, ?5, 1, ?6, ?6
       WHERE (SELECT count(*) FROM catalogs WHERE kind = 'custom') < ?7
         AND NOT EXISTS (SELECT 1 FROM catalogs WHERE kind = 'custom' AND index_url = ?4)
         AND NOT EXISTS (SELECT 1 FROM catalogs WHERE id = ?1)`,
    )
    .bind(
      id,
      parsed.label,
      parsed.colour,
      parsed.indexUrl,
      storedKeys(parsed.keys),
      now.getTime(),
      MAX_CUSTOM_CATALOGS,
    )
    .run();
  if (inserted.meta.changes !== 1) {
    const current = await listCatalogRecords(db);
    if (current.filter((r) => r.kind === "custom").length >= MAX_CUSTOM_CATALOGS) throw full();
    await refuseDuplicateUrl(deps, parsed.indexUrl, null);
    throw new CatalogAdminError("Another catalog was added at the same time. Try again.");
  }
  // Nothing an earlier catalog of this id verified is ever read for this one.
  await forgetCustomCatalogCaches(deps.kv, id);
  await cacheCustomCatalogIndex(
    deps.kv,
    { catalogId: id, url: parsed.indexUrl },
    checked.index,
    checked.etag,
  );
  return { id, checked: checked.checked };
}

async function customRecord(deps: CatalogAdminDeps, id: string) {
  const record = await readCatalogRecord(createDb(deps.db), id);
  if (record === null) throw new CatalogAdminError("There is no such catalog.");
  if (record.kind === "official") {
    throw new CatalogAdminError(
      "The official catalog cannot be changed or removed; turn it off instead.",
    );
  }
  return record;
}

/**
 * Changes a custom catalog's label, colour, index URL or keys. A new URL or
 * new keys are checked like a new catalog before anything is saved.
 */
export async function updateCatalogCore(
  deps: CatalogAdminDeps,
  input: CatalogInput & { id: string },
): Promise<void> {
  const record = await customRecord(deps, input.id);
  const parsed = parseInput(input);
  const keysChanged =
    JSON.stringify(parsed.keys.map((k) => [k.keyId, k.publicKeyBase64])) !==
    JSON.stringify(record.keys.map((k) => [k.keyId, k.publicKeyBase64]));
  const urlChanged = parsed.indexUrl !== record.indexUrl;
  const now = (deps.now ?? (() => new Date()))();
  let checked: CheckedCatalog | null = null;
  if (urlChanged) await refuseDuplicateUrl(deps, parsed.indexUrl, record.id);
  if (urlChanged || keysChanged) {
    const fetchImpl: FetchLike = deps.fetch ?? ((i, init) => fetch(i, init));
    checked = await checkCatalog(fetchImpl, parsed.indexUrl, parsed.keys);
  }
  // What the old keys verified is not trusted under the new ones.
  if (keysChanged) await forgetCustomCatalogCaches(deps.kv, record.id);
  await createDb(deps.db)
    .update(catalogs)
    .set({
      label: parsed.label,
      colour: parsed.colour,
      index_url: parsed.indexUrl,
      keys_json: storedKeys(parsed.keys),
      ...(checked === null ? {} : { refreshed_at: now, refresh_error: null }),
    })
    .where(eq(catalogs.id, record.id));
  if (checked !== null) {
    await cacheCustomCatalogIndex(
      deps.kv,
      { catalogId: record.id, url: parsed.indexUrl },
      checked.index,
      checked.etag,
    );
  }
}

/** Turns a catalog (the official one too) off or on. Nothing else changes. */
export async function setCatalogEnabledCore(
  deps: CatalogAdminDeps,
  input: { id: string; enabled: boolean },
): Promise<void> {
  const result = await createDb(deps.db)
    .update(catalogs)
    .set({ enabled: input.enabled })
    .where(eq(catalogs.id, input.id))
    .returning({ id: catalogs.id });
  if (result.length === 0) throw new CatalogAdminError("There is no such catalog.");
}

/**
 * Removes a custom catalog. Refused while an install from it is not
 * uninstalled: its updates, revisions and checks come from this catalog,
 * and its releases verify with this catalog's keys.
 */
export async function deleteCatalogCore(
  deps: CatalogAdminDeps,
  input: { id: string },
): Promise<void> {
  const record = await customRecord(deps, input.id);
  const db = createDb(deps.db);
  const active = await db
    .select({ worker: installs.worker_name, displayName: installs.display_name })
    .from(installs)
    .where(and(eq(installs.catalog_id, record.id), ne(installs.status, "uninstalled")));
  if (active.length > 0) {
    const names = active.map((r) =>
      installLabel({ displayName: r.displayName, workerName: r.worker }),
    );
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
    throw new CatalogAdminError(
      `${record.label} cannot be removed while apps installed from it are still installed (${shown}${more}): their updates and checks come from this catalog, and its key verifies them. Uninstall them first.`,
    );
  }
  // Only if nothing was installed from it in the meantime.
  const deleted = await deps.db
    .prepare(
      `DELETE FROM catalogs WHERE id = ?1 AND kind = 'custom'
         AND NOT EXISTS (SELECT 1 FROM installs WHERE catalog_id = ?1 AND status <> 'uninstalled')`,
    )
    .bind(record.id)
    .run();
  if (deleted.meta.changes !== 1) {
    throw new CatalogAdminError(
      `${record.label} cannot be removed while apps installed from it are still installed. Uninstall them first.`,
    );
  }
  await forgetCustomCatalogCaches(deps.kv, record.id);
}

/** Active installs per catalog id (repositories not counted). */
export async function installCountsByCatalog(d1: D1Database): Promise<Map<string, number>> {
  const rows = await createDb(d1)
    .select({ id: installs.catalog_id, n: sql<number>`count(*)` })
    .from(installs)
    .where(ne(installs.status, "uninstalled"))
    .groupBy(installs.catalog_id);
  return new Map(rows.filter((r) => r.id !== null).map((r) => [r.id as string, Number(r.n)]));
}
