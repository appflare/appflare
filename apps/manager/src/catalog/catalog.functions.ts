import { env } from "cloudflare:workers";
import type { CatalogManifest, IndexApp } from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { ne } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db/client";
import { installs } from "../db/schema";
import { planBindings } from "../jobs/install/bindings";
import { requireRole, requireSession } from "../server/auth.server";
import { getAppManifest } from "./app-manifest.server";
import { CatalogError, getCatalogIndex, refreshCatalogIndex } from "./index.server";

/** Catalog browsing. */

export interface InstalledRef {
  installId: string;
  status: string;
  workerName: string;
}

export interface CatalogListItem extends IndexApp {
  installed: InstalledRef | null;
}

export interface CatalogList {
  apps: CatalogListItem[];
  /** ISO 8601 of the last successful refresh. */
  updatedAt: string | null;
  /** Why the index is unavailable (nothing cached and the fetch failed). */
  error: string | null;
}

async function activeInstallsBySlug(): Promise<Map<string, InstalledRef>> {
  const rows = await createDb(env.DB)
    .select({
      id: installs.id,
      slug: installs.app_slug,
      status: installs.status,
      worker: installs.worker_name,
    })
    .from(installs)
    .where(ne(installs.status, "uninstalled"));
  return new Map(
    rows.map((r) => [r.slug, { installId: r.id, status: r.status, workerName: r.worker }]),
  );
}

/** Any signed-in user. */
export const listCatalog = createServerFn({ method: "GET" }).handler(
  async (): Promise<CatalogList> => {
    await requireSession();
    const [read, installed] = await Promise.all([getCatalogIndex(env), activeInstallsBySlug()]);
    if (!read.ok) return { apps: [], updatedAt: read.updatedAt, error: read.error };
    return {
      apps: read.index.apps.map((app) => ({ ...app, installed: installed.get(app.slug) ?? null })),
      updatedAt: read.updatedAt,
      error: null,
    };
  },
);

/** Admin only: re-fetch `index.json` now. */
export const refreshCatalog = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ updatedAt: string | null; count: number }> => {
    await requireRole("admin");
    try {
      const snapshot = await refreshCatalogIndex(env);
      return { updatedAt: snapshot.updatedAt, count: snapshot.index.apps.length };
    } catch (error) {
      if (error instanceof CatalogError) throw new Error(error.message);
      throw error;
    }
  },
);

export interface CatalogDetail {
  app: IndexApp | null;
  /** The signed catalog manifest (form definitions, links, license). */
  catalog: CatalogManifest | null;
  /** Resources the install will create, by binding (`kv`, `d1`, ...). */
  creates: Array<{ kind: string; binding: string }>;
  durableObjects: string[];
  /** Why the index or the manifest could not be loaded. */
  error: string | null;
  installed: InstalledRef | null;
}

/** Any signed-in user. */
export const getCatalogEntry = createServerFn({ method: "GET" })
  .validator(z.object({ slug: z.string().min(1).max(100) }))
  .handler(async ({ data }): Promise<CatalogDetail> => {
    await requireSession();
    const empty = { catalog: null, creates: [], durableObjects: [], installed: null };
    const read = await getCatalogIndex(env);
    if (!read.ok) return { app: null, error: read.error, ...empty };
    const app = read.index.apps.find((a) => a.slug === data.slug) ?? null;
    if (app === null) return { app: null, error: null, ...empty };
    const installed = (await activeInstallsBySlug()).get(app.slug) ?? null;
    const manifest = await getAppManifest(env, app);
    if (!manifest.ok) return { ...empty, app, installed, error: manifest.error };
    const plan = planBindings(
      manifest.manifest.catalog.install.workerName,
      manifest.manifest.worker.bindings,
    );
    return {
      app,
      catalog: manifest.manifest.catalog,
      creates: plan.resources.map((r) => ({ kind: r.kind, binding: r.binding })),
      durableObjects: plan.durableObjects.map((d) => d.className),
      error: null,
      installed,
    };
  });
