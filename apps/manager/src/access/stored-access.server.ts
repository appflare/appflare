import { accessBypassPaths, type CatalogAccess } from "@appflare/schema";
import { type StoredRelease, storedRevisedCatalog } from "../catalog/revisions.server";
import type { Database } from "../db/client";
import { accessOfManifestJson } from "../jobs/update/plan";

/**
 * How an installed app (or the version a snapshot kept) goes with
 * Cloudflare Access, as its catalog entry says: the `access` block of the
 * newest revision recorded for its release, else that of the signed
 * `manifest.json` it was installed from. A revision may add, change or
 * remove the block without a new build, so every decision about an
 * install's protection (whether it must stay protected, what stays public)
 * reads it from here rather than from the stored manifest alone.
 */
export async function storedCatalogAccess(
  orm: Database,
  stored: StoredRelease,
): Promise<{ access?: CatalogAccess }> {
  const revised = await storedRevisedCatalog(orm, stored);
  if (revised === null) return accessOfManifestJson(stored.manifestJson);
  return revised.access === undefined ? {} : { access: revised.access };
}

/** The paths a stored release keeps public while protected ({@link storedCatalogAccess}). */
export async function storedBypassPaths(
  orm: Database,
  stored: StoredRelease,
): Promise<readonly string[]> {
  return accessBypassPaths(await storedCatalogAccess(orm, stored));
}

/**
 * The installed apps whose catalog entry requires Cloudflare Access
 * protection while Appflare does not protect them: a catalog revision may
 * make an installed app's protection required, and Appflare never protects
 * an app on its own. Read on every page (Home's "Needs attention"), so it is
 * one D1 query with no bound list, whatever the number of installs: each
 * install joined to the revision recorded for its release and to its Access
 * record, reading only `access.mode` from the stored JSON.
 *
 * The revision applies as `storedRevisedCatalog` decides, as far as SQL can
 * tell: the row recorded for the install's release digest (there is one, the
 * newest), signed with the release's key id, and above the revision the
 * release was built with. A row is only ever recorded after it verified
 * against that release, so its other checks held when it was written.
 */
export async function requiredButUnprotected(d1: D1Database): Promise<Set<string>> {
  const { results } = await d1
    .prepare(
      `SELECT i.id AS id
       FROM installs i
       LEFT JOIN catalog_revisions r ON r.artifact_digest = i.artifact_digest
       LEFT JOIN install_access a ON a.install_id = i.id
       WHERE i.status = 'installed'
         AND i.build_kind != 'self-deploying'
         AND i.manifest_json IS NOT NULL
         AND a.access_app_id IS NULL
         AND (CASE
               WHEN r.revision IS NOT NULL
                 AND r.key_id = json_extract(i.manifest_json, '$.keyId')
                 AND r.revision > COALESCE(json_extract(i.manifest_json, '$.catalog.revision'), 1)
               THEN json_extract(r.catalog_json, '$.access.mode')
               ELSE json_extract(i.manifest_json, '$.catalog.access.mode')
             END) = 'required'`,
    )
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}
