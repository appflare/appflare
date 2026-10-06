import { isVersionPreviewHost, workerNameFromHost } from "../cloudflare/worker-name";
import { SETTING } from "../db/settings";

/**
 * While Appflare lives on a custom domain, its workers.dev address sends
 * page requests there: a GET or HEAD for a page on
 * `<worker>.<subdomain>.workers.dev` answers 302 with the same path and
 * query on the custom domain. It is a 302, not a 301, because browsers keep
 * a 301 for good and the address can change again or go back.
 *
 * Left alone: other methods (a form post or a server function call must not
 * be turned into a GET elsewhere), `/api/health` (health checks and the
 * installer read the workers.dev address), `/api/handoff` (the browser
 * installer proves the address it chose, which a redirect would fail), server functions, static assets
 * (served before the Worker runs), version preview hosts (a self-update
 * checks its new version there), and every other host.
 *
 * Runs before the Cloudflare Access check: once Appflare moved, Access
 * protects the custom domain, not workers.dev.
 */

/** Paths never redirected, and prefixes of them. */
const EXEMPT_PATHS: ReadonlySet<string> = new Set(["/api/health", "/api/handoff"]);
const EXEMPT_PREFIXES = ["/_serverFn/", "/assets/"] as const;

/**
 * The URL to send this request to, or null to serve it here. `managerHostname`
 * is Appflare's custom domain (null while it has none) and `workerName` its
 * own Worker's name.
 */
export function addressRedirectTarget(
  request: Pick<Request, "method" | "url">,
  managerHostname: string | null,
  workerName: string | null,
): string | null {
  if (managerHostname === null || workerName === null) return null;
  if (!isRedirectCandidate(request)) return null;
  const url = new URL(request.url);
  if (!isManagerWorkersDevHost(url.hostname, workerName)) return null;
  if (url.hostname === managerHostname) return null;
  return `https://${managerHostname}${url.pathname}${url.search}`;
}

/**
 * Whether the request could be redirected at all, before anything is read:
 * a GET or HEAD for a page on a workers.dev host.
 */
function isRedirectCandidate(request: Pick<Request, "method" | "url">): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url);
  if (!url.hostname.endsWith(".workers.dev")) return false;
  if (EXEMPT_PATHS.has(url.pathname)) return false;
  return !EXEMPT_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

/** `<workerName>.<subdomain>.workers.dev` itself, not one of its preview hosts. */
export function isManagerWorkersDevHost(hostname: string, workerName: string): boolean {
  if (isVersionPreviewHost(hostname, workerName)) return false;
  return workerNameFromHost(hostname) === workerName.toLowerCase();
}

interface AddressRows {
  managerHostname: string | null;
  workerName: string | null;
}

export interface AddressRedirect {
  /** The 302 to send instead, or null to serve the request here. */
  check(request: Request, db: D1Database): Promise<Response | null>;
  /** Drops the cached address so the next request reads it again. */
  invalidate(): void;
}

/**
 * The redirect with the address read from `settings` at most once per
 * `ttlMs` per isolate, and only for requests that could be redirected. A
 * move calls `invalidate()` in its isolate; others follow within `ttlMs`.
 * A failed read serves the request here.
 */
export function createAddressRedirect(
  options: { ttlMs?: number; now?: () => number } = {},
): AddressRedirect {
  const ttlMs = options.ttlMs ?? 15_000;
  const now = options.now ?? Date.now;
  let cached: { rows: AddressRows; expiresAt: number } | null = null;

  async function rows(db: D1Database): Promise<AddressRows> {
    if (cached !== null && now() < cached.expiresAt) return cached.rows;
    const { results } = await db
      .prepare("SELECT key, value FROM settings WHERE key IN (?1, ?2)")
      .bind(SETTING.managerHostname, SETTING.workerName)
      .all<{ key: string; value: string }>();
    const s = new Map(results.map((r) => [r.key, r.value]));
    const read: AddressRows = {
      managerHostname: s.get(SETTING.managerHostname) || null,
      workerName: s.get(SETTING.workerName) || null,
    };
    cached = { rows: read, expiresAt: now() + ttlMs };
    return read;
  }

  return {
    async check(request, db) {
      if (!isRedirectCandidate(request)) return null;
      let read: AddressRows;
      try {
        read = await rows(db);
      } catch (error) {
        console.error("address: could not read Appflare's address", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      const target = addressRedirectTarget(request, read.managerHostname, read.workerName);
      if (target === null) return null;
      return new Response(null, {
        status: 302,
        headers: { location: target, "cache-control": "no-store" },
      });
    },
    invalidate() {
      cached = null;
    },
  };
}

/** The one redirect the Worker uses; moving the address invalidates it. */
export const addressRedirect: AddressRedirect = createAddressRedirect();

/** Paths TanStack Start answers first: server routes and server functions. */
export function isServerPath(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/_serverFn/");
}

/**
 * Serves a request the way the static assets did before page requests
 * reached the Worker: a GET or HEAD outside the server paths is answered from
 * `assets`, which with `not_found_handling: "single-page-application"`
 * answers the SPA shell (200) for any path that matches no file. Everything
 * else goes to `app`, TanStack Start: server routes and functions, and a
 * 404 from the assets, which happens only while the shell does not exist
 * yet (the build renders it through the Worker).
 */
export async function serveRequest(
  request: Request,
  assets: Pick<Fetcher, "fetch">,
  app: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (!readOnly || isServerPath(new URL(request.url).pathname)) return app(request);
  const asset = await assets.fetch(request);
  if (asset.status !== 404) return asset;
  await asset.body?.cancel();
  return app(request);
}
