import { env } from "cloudflare:workers";
import { artifactManifestSchema, renderPlaceholders, type TokenPermission } from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getAppManifest } from "../catalog/app-manifest.server";
import { getCatalogIndex } from "../catalog/index.server";
import { isUpdateAvailable } from "../catalog/versions";
import { getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { type HealthStatus, installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { isRestoreJob, reconcileJobs } from "../jobs/reconcile.server";
import { requireRole, requireSession } from "../server/auth.server";
import { type EmailRouteView, emailRouteViews, SEND_EMAIL_NOTE, sendsEmail } from "./email-routing";
import { startInstallInput } from "./install-input";
import { renderPostInstall, workersDevUrl } from "./post-install";
import { CUSTOM_DOMAIN_KIND, EMAIL_ROUTE_KIND } from "./resource-kinds";
import { StartInstallError, startInstallCore } from "./start-install.server";

/** Installs: start one (admin), list them, and show one. Uninstall lives in `uninstall.functions.ts`. */

/** Admin only. Returns ids; the UI navigates to `/jobs/$jobId`. */
export const startInstall = createServerFn({ method: "POST" })
  .validator(startInstallInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    try {
      return await startInstallCore(
        {
          db: env.DB,
          workflows: env.JOBS,
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
          async listAccountWorkers() {
            const api = await getCfClient(env);
            return (await api.workers.listScripts()).map((s) => s.id);
          },
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
  /** The app's name from the catalog. */
  name: string;
  /** The install's own label (`instance_name`), the Worker name when unset. */
  instanceName: string;
  workerName: string;
  status: string;
  version: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  workerUrl: string | null;
  /** ISO 8601 */
  updatedAt: string;
  /** ISO 8601; null until the install is uninstalled. */
  uninstalledAt: string | null;
  /** The last health check of the Worker's URL; null until one ran. */
  healthStatus: HealthStatus | null;
  /** ISO 8601; when that check ran. */
  healthCheckedAt: string | null;
}

/** The health fields of an install row, for the list and the detail page. */
function healthOf(row: typeof installs.$inferSelect) {
  return {
    healthStatus: row.health_status,
    healthCheckedAt: row.health_checked_at?.toISOString() ?? null,
  };
}

async function subdomain(): Promise<string | null> {
  const s = await readSettings(createDb(env.DB), [SETTING.accountSubdomain]);
  return s.account_subdomain || null;
}

/** Any signed-in user: every install, uninstalled ones included, newest first. */
export const listInstalls = createServerFn({ method: "GET" }).handler(
  async (): Promise<InstallRow[]> => {
    await requireSession();
    const [rows, read, sub] = await Promise.all([
      createDb(env.DB).select().from(installs).orderBy(desc(installs.installed_at)),
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
        instanceName: row.instance_name ?? row.worker_name,
        workerName: row.worker_name,
        status: row.status,
        version: row.catalog_version,
        latestVersion: listed?.version ?? null,
        updateAvailable:
          row.status === "installed" && isUpdateAvailable(row.catalog_version, listed?.version),
        workerUrl: row.status === "installed" ? workersDevUrl(row.worker_name, sub) : null,
        updatedAt: row.updated_at.toISOString(),
        uninstalledAt: row.uninstalled_at?.toISOString() ?? null,
        ...healthOf(row),
      };
    });
  },
);

export interface ResourceView {
  id: string;
  kind: string;
  binding: string | null;
  name: string;
  cfId: string | null;
}

/** A custom domain of the install (a `domain` resource). */
export interface CustomDomainView {
  /** The `resources` row id. */
  id: string;
  hostname: string;
  /** `https://<hostname>` */
  url: string;
}

export interface InstallDetail extends InstallRow {
  currentVersionId: string | null;
  pinSha: string | null;
  /** The settings the admin changed at install, with placeholders filled in. */
  vars: Record<string, string>;
  /** Resources in the account that belong to the install (secrets excluded). */
  resources: ResourceView[];
  /** Resources an uninstall kept in the account; they remain until deleted by hand. */
  retained: ResourceView[];
  secretNames: string[];
  /** Custom domains that serve the Worker, in the order they were added. */
  domains: CustomDomainView[];
  /** What the install set up in Email Routing, in the order it was set up. */
  emailRoutes: EmailRouteView[];
  /** Which uninstall action the page offers now. */
  uninstall: "start" | "retry" | null;
  /** The job currently queued or running for this install, if any. */
  activeJobId: string | null;
  jobs: Array<{
    id: string;
    kind: string;
    /** A database restore (recorded as a `rollback` job). */
    restore: boolean;
    status: string;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  /**
   * Markdown with `{{workerUrl}}`/`{{workerName}}` filled in, then Appflare's
   * own notes (sending email); empty until installed.
   */
  postInstall: string[];
  /** Permissions of the Cloudflare token the app needs for itself, from its signed manifest. */
  tokenPermissions: TokenPermission[];
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
    // A job whose Workflow died outside its own code is settled first, so the
    // page never waits on it forever.
    const active = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.install_id, data.installId), inArray(jobs.status, ["queued", "running"])));
    if (active.length > 0) await reconcileJobs(env.DB, env.JOBS, active);
    const [row] = await db.select().from(installs).where(eq(installs.id, data.installId)).limit(1);
    if (row === undefined) return null;
    const [resourceRows, jobRows, read, sub] = await Promise.all([
      // Everything not deleted: live resources, and those an uninstall kept.
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
    let tokenPermissions: TokenPermission[] = [];
    if (row.manifest_json !== null) {
      const manifest = artifactManifestSchema.safeParse(JSON.parse(row.manifest_json));
      if (manifest.success) {
        name = manifest.data.catalog.name;
        postInstall = manifest.data.catalog.postInstall.map((p) =>
          renderPostInstall(p.content, { workerUrl, workerName: row.worker_name }),
        );
        if (sendsEmail(manifest.data.worker.bindings)) postInstall.push(SEND_EMAIL_NOTE);
        tokenPermissions = manifest.data.catalog.tokenPermissions;
      }
    }
    const view = (r: (typeof resourceRows)[number]): ResourceView => ({
      id: r.id,
      kind: r.kind,
      binding: r.binding,
      name: r.name,
      cfId: r.cf_id,
    });
    const live = resourceRows.filter((r) => r.retained_at === null);
    const activeJob = jobRows.find((j) => j.status === "queued" || j.status === "running");
    let uninstall: InstallDetail["uninstall"] = null;
    if (activeJob === undefined) {
      if (row.status === "installed" || row.status === "failed") uninstall = "start";
      else if (row.status === "uninstalling") {
        uninstall = "retry";
      }
    }
    return {
      id: row.id,
      slug: row.app_slug,
      name,
      instanceName: row.instance_name ?? row.worker_name,
      workerName: row.worker_name,
      status: row.status,
      version: row.catalog_version,
      latestVersion: listed?.version ?? null,
      updateAvailable:
        row.status === "installed" && isUpdateAvailable(row.catalog_version, listed?.version),
      workerUrl: row.status === "installed" ? workerUrl : null,
      updatedAt: row.updated_at.toISOString(),
      uninstalledAt: row.uninstalled_at?.toISOString() ?? null,
      ...healthOf(row),
      currentVersionId: row.current_version_id,
      pinSha: row.pin_sha,
      // As the Worker gets them: placeholders are kept as entered and filled in by the jobs.
      vars: Object.fromEntries(
        Object.entries(parseVars(row.config_json)).map(([name, value]) => [
          name,
          renderPlaceholders(value, { workerUrl, workerName: row.worker_name }),
        ]),
      ),
      // Email routes are listed under Email; their ids carry encoded state.
      resources: live.filter((r) => r.kind !== "secret" && r.kind !== EMAIL_ROUTE_KIND).map(view),
      retained: resourceRows.filter((r) => r.retained_at !== null).map(view),
      secretNames: live.filter((r) => r.kind === "secret").map((r) => r.name),
      domains: live
        .filter((r) => r.kind === CUSTOM_DOMAIN_KIND)
        .map((r) => ({ id: r.id, hostname: r.name, url: `https://${r.name}` })),
      emailRoutes: emailRouteViews(
        live
          .filter((r) => r.kind === EMAIL_ROUTE_KIND)
          .map((r) => ({ id: r.id, name: r.name, cfId: r.cf_id })),
      ),
      uninstall,
      activeJobId: activeJob?.id ?? null,
      jobs: jobRows.map((j) => ({
        id: j.id,
        kind: j.kind,
        restore: isRestoreJob(j),
        status: j.status,
        error: j.error,
        startedAt: j.started_at?.toISOString() ?? null,
        finishedAt: j.finished_at?.toISOString() ?? null,
      })),
      postInstall,
      tokenPermissions,
    };
  });
