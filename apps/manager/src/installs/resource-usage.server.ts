import type { CloudflareClient } from "@appflare/cf-api";

/**
 * What a data resource holds, for the uninstall dialog, where the API tells
 * cheaply: one call per resource. KV reports its key count (up to one page of
 * 1,000 keys, then "more"); D1 its size in bytes. Anything else, or any call
 * that fails, is left out: this is information, never a gate.
 */

export interface ResourceUsage {
  id: string;
  kvKeys?: { count: number; more: boolean };
  d1Bytes?: number;
}

/** Keys counted per KV namespace (one list call; Cloudflare's maximum page). */
const KV_COUNT_LIMIT = 1000;

export async function readResourceUsage(
  api: CloudflareClient,
  rows: ReadonlyArray<{ id: string; kind: string; cfId: string | null }>,
): Promise<ResourceUsage[]> {
  const read = async (row: (typeof rows)[number]): Promise<ResourceUsage | null> => {
    if (row.cfId === null) return null;
    try {
      if (row.kind === "kv") {
        const page = await api.kv.listKeys(row.cfId, { limit: KV_COUNT_LIMIT });
        return { id: row.id, kvKeys: { count: page.items.length, more: page.cursor !== null } };
      }
      if (row.kind === "d1") {
        const bytes = (await api.d1.getDatabase(row.cfId)).file_size;
        return typeof bytes === "number" ? { id: row.id, d1Bytes: bytes } : null;
      }
    } catch {
      // Usage is optional detail; the dialog shows the resource without it.
    }
    return null;
  };
  const results = await Promise.all(rows.map(read));
  return results.filter((r): r is ResourceUsage => r !== null);
}
