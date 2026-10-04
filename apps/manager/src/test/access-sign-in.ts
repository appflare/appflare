import { AUD, TEAM_DOMAIN } from "./access-jwt";

/**
 * Test-only stand-in for Cloudflare Access answering a request without an
 * Access session: a 302 to the team's sign-in page, in the shape the edge
 * sends for a protected workers.dev host (the Worker's own URL and its
 * version preview URLs alike).
 */

/** The `Location` Access redirects a request for `host` to. */
export function accessLoginUrl(host: string, path = "/"): string {
  const meta = "eyJraWQiOiJ0ZXN0IiwiYWxnIjoiUlMyNTYifQ";
  return `https://${TEAM_DOMAIN}/cdn-cgi/access/login/${host}?kid=${AUD}&redirect_url=${encodeURIComponent(path)}&meta=${meta}`;
}

/** Access's answer to a request for `host` without an Access session. */
export function accessChallenge(host: string, path = "/"): Response {
  return new Response(null, { status: 302, headers: { location: accessLoginUrl(host, path) } });
}
