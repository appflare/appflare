import { SETTING } from "../db/settings";
import type { AddressStatus } from "./address-watch";

/**
 * Where Appflare lives and whether it waits to move, for a page open at
 * workers.dev (address-watch.ts): one D1 read of two settings rows, no
 * Cloudflare call. Public: neither the address nor the fact that a move is
 * pending is a secret (the workers.dev address redirects there anyway).
 */
export async function readAddressStatus(db: D1Database): Promise<AddressStatus> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key IN (?1, ?2)")
    .bind(SETTING.managerHostname, SETTING.managerPendingHostname)
    .all<{ key: string; value: string }>();
  const s = new Map(results.map((r) => [r.key, r.value]));
  const hostname = s.get(SETTING.managerHostname) || null;
  return { hostname, pending: hostname === null && Boolean(s.get(SETTING.managerPendingHostname)) };
}
