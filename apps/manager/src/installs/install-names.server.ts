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
 * Without one (not recorded yet, or unreadable), the app's slug, less the
 * prefix a repository's slug carries.
 */
export function recordedName(row: { app_slug: string; manifest_json: string | null }): string {
  if (row.manifest_json !== null) {
    try {
      const m = JSON.parse(row.manifest_json) as { catalog?: { name?: unknown }; name?: unknown };
      const name = m.catalog?.name ?? m.name;
      if (typeof name === "string" && name.length > 0) return name;
    } catch {
      // Not a manifest; the slug below names it.
    }
  }
  return row.app_slug.replace(REPOSITORY_SLUG_PREFIX, "");
}

/** What `recordedName` and `distinctLabels` read of an install row. */
export interface InstallNameRow {
  id: string;
  app_slug: string;
  worker_name: string;
  display_name: string | null;
  manifest_json: string | null;
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
      `SELECT id, app_slug, worker_name, display_name, manifest_json
       FROM installs WHERE status <> 'uninstalled'`,
    )
    .all<InstallNameRow>();
  return results.map(namedInstall);
}

/**
 * The labels of `named` (see `distinctLabels`), each told apart from every
 * install that is not uninstalled as well as from the others named with it.
 * An install in `named` keeps the app name given there. One D1 query.
 */
export async function readInstallLabels(
  db: D1Database,
  named: readonly NamedInstall[],
): Promise<Map<string, string>> {
  const given = new Set(named.map((n) => n.id));
  const others = (await readInstallNames(db)).filter((n) => !given.has(n.id));
  return distinctLabels([...named, ...others]);
}
