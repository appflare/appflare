/**
 * The site's Worker. Static files answer every request on their own; this
 * code runs only for `/api/install/*` (wrangler.jsonc's `run_worker_first`),
 * which it hands, unchanged, to the hosted installer through a service
 * binding. The deploy page and the installer's API so share one origin, and
 * the browser never makes a cross-origin request to the installer.
 *
 * Nothing here reads or logs the request: it carries the visitor's
 * Cloudflare access token in its Authorization header.
 */

/** A binding that answers requests: the static files, or another Worker. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  /** The site's static files. */
  ASSETS: Fetcher;
  /** The hosted installer, `appflare-installer`, its default entrypoint. */
  INSTALLER: Fetcher;
}

export const INSTALLER_PREFIX = "/api/install/";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith(INSTALLER_PREFIX)) return env.INSTALLER.fetch(request);
    // Not reached while run_worker_first names only the installer's path;
    // kept so a wider pattern still serves the site.
    return env.ASSETS.fetch(request);
  },
};
