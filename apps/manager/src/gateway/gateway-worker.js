// The gateway Worker ("appflare-gateway"), uploaded by the manager exactly as
// written here (it is imported as text, so it must stay one dependency-free
// ES module). It runs on the route that matches every request of the gateway
// zone: the zone's own sites and every external domain served through
// Cloudflare for SaaS custom hostnames on it.
//
// - A host that is the gateway zone or a name under it is the zone's own:
//   passed through to its origin untouched with `fetch(request)` (a Worker on a
//   route reaches the zone's origin that way), except the gateway's own
//   hostname, which answers who it is.
// - Any other host is looked up in the ROUTES KV namespace (hostname ->
//   service binding name). A registered host is forwarded to the app's Worker
//   over that service binding with the request unchanged, so the app sees the
//   original URL and Host.
// - A host that is not registered is passed through as well: the zone decides
//   what it serves (a custom hostname added outside Appflare keeps working).
// - A registered host whose binding this version lacks, or a routing table
//   that cannot be read, gets a plain 502: passing such a request through
//   would send an app's visitors to the fallback origin.
//
// Lookups are cached in the isolate for a few seconds, and by KV at the edge.

/** How long an isolate trusts a lookup, in milliseconds. */
const CACHE_MS = 10_000;
/** Seconds KV may serve a lookup from its edge cache (60 is its minimum). */
const KV_CACHE_TTL = 60;
/** Lookups kept per isolate before the cache starts over. */
const CACHE_LIMIT = 1000;

/** @type {Map<string, { binding: string | null, until: number }>} */
const cache = new Map();

/** Test seam: forgets every cached lookup. */
export function clearGatewayCache() {
  cache.clear();
}

/**
 * @param {import("./gateway-worker").GatewayEnv} env
 * @param {string} host
 * @returns {Promise<string | null>}
 */
async function bindingFor(env, host) {
  const now = Date.now();
  const hit = cache.get(host);
  if (hit !== undefined && hit.until > now) return hit.binding;
  const binding = await env.ROUTES.get(host, { cacheTtl: KV_CACHE_TTL });
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(host, { binding, until: now + CACHE_MS });
  return binding;
}

/**
 * @param {string} message
 * @returns {Response}
 */
function unavailable(message) {
  return new Response(message, {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * @param {string} host
 * @param {string} zone
 */
function isZoneHost(host, zone) {
  return zone.length > 0 && (host === zone || host.endsWith(`.${zone}`));
}

export default {
  /**
   * @param {Request} request
   * @param {import("./gateway-worker").GatewayEnv} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const host = new URL(request.url).hostname.toLowerCase();
    const zone = String(env.ZONE_NAME ?? "").toLowerCase();
    if (isZoneHost(host, zone)) {
      if (host === String(env.CNAME_TARGET ?? "").toLowerCase()) {
        return Response.json(
          { service: "appflare-gateway", version: env.GATEWAY_VERSION ?? null },
          { headers: { "cache-control": "no-store" } },
        );
      }
      return fetch(request);
    }
    /** @type {string | null} */
    let name;
    try {
      name = await bindingFor(env, host);
    } catch {
      return unavailable(
        `The gateway could not read its routing table for ${host}. Try again shortly.`,
      );
    }
    if (name === null) return fetch(request);
    /** @type {unknown} */
    const target = env[name];
    if (
      typeof target === "object" &&
      target !== null &&
      "fetch" in target &&
      typeof target.fetch === "function"
    ) {
      return target.fetch(request);
    }
    return unavailable(`No app answers for ${host} at the moment.`);
  },
};
