import { SETTING } from "../db/settings";
import { workersDevUrl } from "../installs/post-install";

/**
 * Where links to this manager point: notifications, and the appflare.dev
 * link that remembers this manager in a browser. One answer for all of them,
 * so a message and the page it links from never disagree about the address.
 */

/**
 * The origin an admin last managed notification channels from (a `settings`
 * row the notifications module writes): the best guess at the address people
 * use while Appflare has no address of its own.
 */
export const MANAGER_URL_KEY = "notification_manager_url";

const KEYS = [
  SETTING.managerHostname,
  MANAGER_URL_KEY,
  SETTING.accessDomain,
  SETTING.workerName,
  SETTING.accountSubdomain,
] as const;

/** An origin a link may point at: `https:`, or plain `http:` on localhost (development). */
function linkableOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return parsed.origin;
    return parsed.protocol === "http:" && parsed.hostname === "localhost" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The manager's origin (`https://<host>`, no trailing slash), first match:
 * 1. Appflare's address (`manager_hostname`), when it lives on a custom domain;
 * 2. the origin serving `request`, when there is one;
 * 3. the origin an admin last managed notification channels from;
 * 4. the hostname Cloudflare Access protects;
 * 5. its workers.dev URL.
 * Null when none is known (no request, and setup has not found the Worker).
 */
export async function managerOrigin(
  env: { DB: D1Database },
  request?: Request | null,
): Promise<string | null> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${KEYS.map((_, i) => `?${i + 1}`).join(", ")})`,
  )
    .bind(...KEYS)
    .all<{ key: string; value: string }>();
  const s = new Map(results.map((row) => [row.key, row.value]));
  const hostname = s.get(SETTING.managerHostname);
  if (hostname) return `https://${hostname}`;
  const served = request ? linkableOrigin(request.url) : null;
  if (served !== null) return served;
  const remembered = s.get(MANAGER_URL_KEY);
  if (remembered) return remembered;
  const access = s.get(SETTING.accessDomain);
  if (access) return `https://${access}`;
  const workerName = s.get(SETTING.workerName);
  return workerName ? workersDevUrl(workerName, s.get(SETTING.accountSubdomain)) : null;
}
