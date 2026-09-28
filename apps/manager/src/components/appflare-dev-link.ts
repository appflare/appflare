/**
 * "Use this Appflare on appflare.dev": a link that tells appflare.dev, in
 * this browser only, which Appflare its Install buttons should open. The
 * manager's address travels in the fragment (`#manager=<origin>`), which a
 * browser never sends to a server, so it stays out of the site's logs; only
 * the origin is sent, never a path. Client-safe.
 */

import { SITE_URL } from "@appflare/schema/links";

/** The appflare.dev page that remembers a manager. */
export const APPFLARE_DEV_MY_URL = `${SITE_URL}/my/`;

/** The link for this manager, or null when its address is not a web origin. */
export function appflareDevLink(managerUrl: string | null | undefined): string | null {
  if (managerUrl === null || managerUrl === undefined) return null;
  let url: URL;
  try {
    url = new URL(managerUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return `${APPFLARE_DEV_MY_URL}#manager=${encodeURIComponent(url.origin)}`;
}
