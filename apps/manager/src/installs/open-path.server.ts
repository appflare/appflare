import { openPathProblem } from "@appflare/schema";

/**
 * Where an installed app's Open buttons go within it: its catalog entry's
 * `openPath`, read from the revision recorded for its release when one
 * applies (signed with the release's key, above the release's own revision),
 * else from the release it runs; a self-deploying install records its catalog
 * manifest itself. Only the Open buttons use it: health checks, `{{appUrl}}`
 * and the addresses the app's page lists stay the root.
 *
 * Read with `json_extract` in one query, like the Access requirement of
 * Home's apps, so a list of installs costs one D1 read and parses no
 * manifest. A value the schema would refuse is dropped, so the app opens at
 * its root.
 */
export async function readOpenPaths(
  d1: D1Database,
  /** One install only; every installed one when omitted. */
  installId?: string,
): Promise<Map<string, string>> {
  const { results } = await d1
    .prepare(
      `SELECT i.id AS id,
         CASE
           WHEN i.build_kind = 'self-deploying' THEN json_extract(i.manifest_json, '$.openPath')
           WHEN r.revision IS NOT NULL
             AND json_valid(r.catalog_json)
             AND r.key_id = json_extract(i.manifest_json, '$.keyId')
             AND r.revision > COALESCE(json_extract(i.manifest_json, '$.catalog.revision'), 1)
           THEN json_extract(r.catalog_json, '$.openPath')
           ELSE json_extract(i.manifest_json, '$.catalog.openPath')
         END AS open_path
       FROM installs i
       LEFT JOIN catalog_revisions r ON r.artifact_digest = i.artifact_digest
       WHERE i.status = 'installed'
         AND i.manifest_json IS NOT NULL
         AND json_valid(i.manifest_json)
         AND (?1 IS NULL OR i.id = ?1)`,
    )
    .bind(installId ?? null)
    .all<{ id: string; open_path: unknown }>();
  const paths = new Map<string, string>();
  for (const row of results) {
    if (typeof row.open_path === "string" && openPathProblem(row.open_path) === null) {
      paths.set(row.id, row.open_path);
    }
  }
  return paths;
}
