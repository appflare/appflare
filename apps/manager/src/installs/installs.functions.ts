import { env } from "cloudflare:workers";
import { artifactManifestSchema } from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getAppManifest } from "../catalog/app-manifest.server";
import { getCatalogIndex } from "../catalog/index.server";
import { isUpdateAvailable } from "../catalog/versions";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { requireRole, requireSession } from "../server/auth.server";
import { startInstallInput } from "./install-input";
import { renderPostInstall, workersDevUrl } from "./post-install";
import { StartInstallError, startInstallCore } from "./start-install.server";

/** Installs: start one (admin), list them, and show one. */

/** Admin only. Returns ids; the UI navigates to `/jobs/$jobId`. */
export const startInstall = createServerFn({ method: "POST" })
  .validator(startInstallInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    try {
      return await startInstallCore(
        {
          db: env.DB,
          async loadApp(slug) {
            const read = await getCatalogIndex(env);
            if (!read.ok) throw new StartInstallError(read.error);
            const app = read.index.apps.find((a) => a.slug === slug);
            if (app === undefined) throw new StartInstallError(`"${slug}" is not in the catalog.`);
            const manifest = await getAppManifest(env, app);
            if (!manifest.ok) throw new StartInstallError(manifest.error);
            return { app, manifest: manifest.manifest };
          },
          createJob: (id, params) => env.JOBS.create({ id, params }),
        },
        data,
      );
    } catch (error) {
      if (error instanceof StartInstallError) throw new Error(error.message);
      throw error;
    }
  });

export interface InstallRow {
  id: string;
  slug: string;
  name: string;
  workerName: string;
  status: string;
  version: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  workerUrl: string | null;
  /** ISO 8601 */
  updatedAt: string;
}

async function subdomain(): Promise<string | null> {
  const s = await readSettings(createDb(env.DB), [SETTING.accountSubdomain]);
  return s.account_subdomain || null;
}

/** Any signed-in user: every install that is not uninstalled, newest first. */
export const listInstalls = createServerFn({ method: "GET" }).handler(
  async (): Promise<InstallRow[]> => {
    await requireSession();
    const [rows, read, sub] = await Promise.all([
      createDb(env.DB)
        .select()
        .from(installs)
        .where(ne(installs.status, "uninstalled"))
        .orderBy(desc(installs.installed_at)),
      getCatalogIndex(env),
      subdomain(),
    ]);
    const catalog = new Map(read.ok ? read.index.apps.map((a) => [a.slug, a]) : []);
    return rows.map((row) => {
      const listed = catalog.get(row.app_slug);
      return {
        id: row.id,
        slug: row.app_slug,
        name: listed?.name ?? row.app_slug,
        workerName: row.worker_name,
        status: row.status,
        version: row.catalog_version,
        latestVersion: listed?.version ?? null,
        updateAvailable:
          row.status === "installed" && isUpdateAvailable(row.catalog_version, listed?.version),
        workerUrl: row.status === "installed" ? workersDevUrl(row.worker_name, sub) : null,
        updatedAt: row.updated_at.toISOString(),
      };
    });
  },
);

export interface InstallDetail extends InstallRow {
  currentVersionId: string | null;
  pinSha: string | null;
  vars: Record<string, string>;
  resources: Array<{
    id: string;
    kind: string;
    binding: string | null;
    name: string;
    cfId: string | null;
  }>;
  secretNames: string[];
  jobs: Array<{
    id: string;
    kind: string;
    status: string;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  /** Markdown with `{{workerUrl}}`/`{{workerName}}` filled in; empty until installed. */
  postInstall: string[];
}

function parseVars(json: string | null): Record<string, string> {
  if (json === null) return {};
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Any signed-in user. Null when there is no such install. */
export const getInstall = createServerFn({ method: "GET" })
  .validator(z.object({ installId: z.string().min(1).max(64) }))
  .handler(async ({ data }): Promise<InstallDetail | null> => {
    await requireSession();
    const db = createDb(env.DB);
    const [row] = await db.select().from(installs).where(eq(installs.id, data.installId)).limit(1);
    if (row === undefined) return null;
    const [resourceRows, jobRows, read, sub] = await Promise.all([
      db
        .select()
        .from(resources)
        .where(and(eq(resources.install_id, row.id), isNull(resources.deleted_at)))
        // Insertion order (created_at can tie within a millisecond).
        .orderBy(sql`rowid`),
      db.select().from(jobs).where(eq(jobs.install_id, row.id)).orderBy(desc(jobs.id)),
      getCatalogIndex(env),
      subdomain(),
    ]);
    const listed = read.ok ? read.index.apps.find((a) => a.slug === row.app_slug) : undefined;
    const workerUrl = workersDevUrl(row.worker_name, sub);
    let name = listed?.name ?? row.app_slug;
    let postInstall: string[] = [];
    if (row.manifest_json !== null) {
      const manifest = artifactManifestSchema.safeParse(JSON.parse(row.manifest_json));
      if (manifest.success) {
        name = manifest.data.catalog.name;
        postInstall = manifest.data.catalog.postInstall.map((p) =>
          renderPostInstall(p.content, { workerUrl, workerName: row.worker_name }),
        );
      }
    }
    return {
      id: row.id,
      slug: row.app_slug,
      name,
      workerName: row.worker_name,
      status: row.status,
      version: row.catalog_version,
      latestVersion: listed?.version ?? null,
      updateAvailable:
        row.status === "installed" && isUpdateAvailable(row.catalog_version, listed?.version),
      workerUrl: row.status === "installed" ? workerUrl : null,
      updatedAt: row.updated_at.toISOString(),
      currentVersionId: row.current_version_id,
      pinSha: row.pin_sha,
      vars: parseVars(row.config_json),
      resources: resourceRows
        .filter((r) => r.kind !== "secret")
        .map((r) => ({ id: r.id, kind: r.kind, binding: r.binding, name: r.name, cfId: r.cf_id })),
      secretNames: resourceRows.filter((r) => r.kind === "secret").map((r) => r.name),
      jobs: jobRows.map((j) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        error: j.error,
        startedAt: j.started_at?.toISOString() ?? null,
        finishedAt: j.finished_at?.toISOString() ?? null,
      })),
      postInstall,
    };
  });
