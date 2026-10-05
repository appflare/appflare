import { sql } from "drizzle-orm";
import { installs } from "../db/schema";
import { distinctLabels, type NamedInstall } from "./display-name";
import { REPOSITORY_SLUG_PREFIX } from "./source-review";

/**
 * The names of installs as the server reads them from D1, for the pages and
 * messages that name an install without the catalog at hand (jobs,
 * notifications, removed apps). Server only.
 */

/**
 * The app's name from an install's recorded manifest: an artifact manifest's
 * `catalog.name`, or a self-deploying install's catalog manifest `name`.
 * The manifest is recorded only once the install finishes, so an install
 * that failed (or is still running) goes by the name its install job
 * recorded when it started (`app_name`, see {@link installJobAppNameSql}),
 * the same name it would have had. Without either (an install started by
 * an older version), the app's slug, less the prefix a repository's slug
 * carries.
 */
export function recordedName(row: {
  app_slug: string;
  manifest_json: string | null;
  app_name?: string | null;
}): string {
  if (row.manifest_json !== null) {
    try {
      const m = JSON.parse(row.manifest_json) as { catalog?: { name?: unknown }; name?: unknown };
      const name = m.catalog?.name ?? m.name;
      if (typeof name === "string" && name.length > 0) return name;
    } catch {
      // Not a manifest; the names below name it.
    }
  }
  if (typeof row.app_name === "string" && row.app_name.length > 0) return row.app_name;
  return row.app_slug.replace(REPOSITORY_SLUG_PREFIX, "");
}

/**
 * A SQL expression for the app's name the install job of the install row
 * `alias` recorded when it started (`appName` in its `input_json`), or NULL.
 * Selected as `app_name` next to `manifest_json` for `recordedName`.
 */
export function installJobAppNameSql(alias: string): string {
  // CASE, not AND: SQLite does not promise to skip json_extract on text that is not JSON.
  return `(SELECT CASE WHEN json_valid(install_job.input_json)
                 THEN json_extract(install_job.input_json, '$.appName') END
     FROM jobs install_job
     WHERE install_job.install_id = ${alias}.id AND install_job.kind = 'install' LIMIT 1)`;
}

/**
 * {@link installJobAppNameSql} as a Drizzle column of a query on `installs`
 * (unaliased), read only while the install has no manifest.
 */
export const installJobAppName = sql<string | null>`CASE WHEN ${installs.manifest_json} IS NULL
  THEN ${sql.raw(installJobAppNameSql('"installs"'))} END`;

/** What `recordedName` and `distinctLabels` read of an install row. */
export interface InstallNameRow {
  id: string;
  app_slug: string;
  worker_name: string;
  display_name: string | null;
  manifest_json: string | null;
  /** The name its install job recorded ({@link installJobAppNameSql}); read when no manifest is. */
  app_name?: string | null;
}

/** An install row's names, the app's name read from its recorded manifest. */
export function namedInstall(row: InstallNameRow): NamedInstall {
  return {
    id: row.id,
    displayName: row.display_name,
    name: recordedName(row),
    workerName: row.worker_name,
  };
}

/** Every install that is not uninstalled, by its names. One D1 query. */
export async function readInstallNames(db: D1Database): Promise<NamedInstall[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.app_slug, i.worker_name, i.display_name, i.manifest_json,
              CASE WHEN i.manifest_json IS NULL THEN ${installJobAppNameSql("i")} END AS app_name
       FROM installs i WHERE i.status <> 'uninstalled'`,
    )
    .all<InstallNameRow>();
  return results.map(namedInstall);
}

/**
 * The labels of `named` (see `distinctLabels`), each told apart from every
 * install that is not uninstalled as well as from the others named with it.
 * An install in `named` keeps the app name given there. One D1 query, none
 * with `all`.
 */
export async function readInstallLabels(
  db: D1Database,
  named: readonly NamedInstall[],
  /** Every install's names (`readInstallNames`), when the caller read them already. */
  all?: readonly NamedInstall[],
): Promise<Map<string, string>> {
  const given = new Set(named.map((n) => n.id));
  const others = (all ?? (await readInstallNames(db))).filter((n) => !given.has(n.id));
  return distinctLabels([...named, ...others]);
}
