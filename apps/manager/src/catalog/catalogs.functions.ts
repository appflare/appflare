import { env } from "cloudflare:workers";
import { publicKeyFingerprint } from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createDb } from "../db/client";
import { requireRole, requireSession } from "../server/auth.server";
import {
  addCatalogCore,
  type CatalogAdminDeps,
  CatalogAdminError,
  deleteCatalogCore,
  installCountsByCatalog,
  setCatalogEnabledCore,
  updateCatalogCore,
} from "./catalog-admin.server";
import { listCatalogRecords, sourceOf } from "./catalogs.server";
import { catalogIndexUrl, readCachedCustomCatalogIndex } from "./index.server";
import { type CatalogSource, catalogColourSchema } from "./sources";

/** Settings, Catalogs: the catalogs this manager browses and installs from. */

export interface CatalogKeyView {
  keyId: string;
  /** `SHA256:...`, to compare with the one the catalog's owner published. */
  fingerprint: string;
  /** The key as it was pasted, to edit it. */
  publicKeyBase64: string;
}

export interface CatalogView extends CatalogSource {
  /** The index URL in force. */
  indexUrl: string;
  enabled: boolean;
  keys: CatalogKeyView[];
  /** ISO 8601; null for the official catalog, which ships with Appflare. */
  addedAt: string | null;
  /** ISO 8601 of the last successful refresh; null until one. */
  refreshedAt: string | null;
  /** Why the last refresh failed; null when it did not. */
  refreshError: string | null;
  /** Apps its cached index lists; null when nothing is cached. */
  apps: number | null;
  /** Installs from it that are not uninstalled. */
  installs: number;
}

async function keyViews(keys: readonly { keyId: string; publicKeyBase64: string }[]) {
  return Promise.all(
    keys.map(async (k) => ({
      keyId: k.keyId,
      publicKeyBase64: k.publicKeyBase64,
      fingerprint: await publicKeyFingerprint(k.publicKeyBase64).catch(() => "unreadable key"),
    })),
  );
}

/** Any signed-in user; only admins can change anything. */
export const listCatalogs = createServerFn({ method: "GET" }).handler(
  async (): Promise<CatalogView[]> => {
    await requireSession();
    const [records, counts] = await Promise.all([
      listCatalogRecords(createDb(env.DB)),
      installCountsByCatalog(env.DB),
    ]);
    return Promise.all(
      records.map(async (record): Promise<CatalogView> => {
        const official = record.kind === "official";
        const cached = official ? null : await readCachedCustomCatalogIndex(env.KV, record.id);
        return {
          ...sourceOf(record),
          indexUrl: official ? catalogIndexUrl(env) : record.indexUrl,
          enabled: record.enabled,
          keys: await keyViews(record.keys),
          addedAt: official ? null : record.addedAt.toISOString(),
          refreshedAt: record.refreshedAt?.toISOString() ?? null,
          refreshError: record.refreshError,
          apps: cached?.index.apps.length ?? null,
          installs: counts.get(record.id) ?? 0,
        };
      }),
    );
  },
);

function deps(): CatalogAdminDeps {
  return {
    db: env.DB,
    kv: env.KV,
    ...(env.CATALOG_INDEX_URL === undefined ? {} : { officialIndexUrl: env.CATALOG_INDEX_URL }),
  };
}

async function asUserError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CatalogAdminError) throw new Error(error.message);
    throw error;
  }
}

const catalogInput = z.object({
  indexUrl: z.string().max(600),
  publicKeys: z.string().max(4000),
  label: z.string().max(200),
  colour: catalogColourSchema,
});

const catalogIdInput = z.object({ id: z.string().min(1).max(64) });

/**
 * Admin only: adds a catalog once its index is valid and one of its
 * releases verifies with the pasted keys. Returns its id and the release
 * that was checked.
 */
export const addCatalog = createServerFn({ method: "POST" })
  .validator(catalogInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return asUserError(() => addCatalogCore(deps(), data));
  });

/** Admin only: changes an added catalog; a new URL or new keys are checked first. */
export const updateCatalog = createServerFn({ method: "POST" })
  .validator(catalogInput.extend(catalogIdInput.shape))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireRole("admin");
    await asUserError(() => updateCatalogCore(deps(), data));
    return { ok: true };
  });

/** Admin only: turns a catalog (the official one too) off or on. */
export const setCatalogEnabled = createServerFn({ method: "POST" })
  .validator(catalogIdInput.extend({ enabled: z.boolean() }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireRole("admin");
    await asUserError(() => setCatalogEnabledCore(deps(), data));
    return { ok: true };
  });

/** Admin only: removes an added catalog; refused while apps installed from it are installed. */
export const deleteCatalog = createServerFn({ method: "POST" })
  .validator(catalogIdInput)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireRole("admin");
    await asUserError(() => deleteCatalogCore(deps(), data));
    return { ok: true };
  });
