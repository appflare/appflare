import { installBuildsPrefix } from "@appflare/schema";

/**
 * Deletes every object under `prefix` for which `shouldDelete` is true.
 * Returns how many were deleted.
 */
export async function deleteUnder(
  bucket: R2Bucket,
  prefix: string,
  shouldDelete: (key: string) => boolean = () => true,
): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key).filter(shouldDelete);
    if (keys.length > 0) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return deleted;
}

/**
 * Deletes an install's builds except the versions in `keepVersions` (the
 * current one, and the previous one a rollback reads). Every version's
 * objects, log included, live under `builds/<installId>/<version>/`.
 */
export function deleteInstallBuilds(
  bucket: R2Bucket,
  installId: string,
  keepVersions: readonly string[],
): Promise<number> {
  const prefix = installBuildsPrefix(installId);
  const keep = new Set(keepVersions);
  return deleteUnder(
    bucket,
    prefix,
    (key) => !keep.has(key.slice(prefix.length).split("/")[0] ?? ""),
  );
}
