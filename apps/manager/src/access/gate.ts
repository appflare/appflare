import { type AccessConfig, readAccessConfig } from "./config";
import { ACCESS_DENIED_CODE, SERVER_FN_HEADER } from "./denied";
import { renderAccessDeniedPage } from "./denied-page";
import { ACCESS_JWT_HEADER, type AccessJwtFailure, verifyAccessJwt } from "./jwt";
import { type AccessKeyStore, createAccessKeyStore } from "./keys";
import { accessRecoverySteps } from "./recovery";

/**
 * The request check that runs in the Worker's `fetch` before any routing while
 * Cloudflare Access protection is on: every request except `/api/health` must
 * carry a `Cf-Access-Jwt-Assertion` that verifies against the team's keys and
 * names this manager's application. Anything else gets a 403 page, including
 * when the check itself cannot run (fail closed).
 *
 * The on/off state is read from `settings` at most once per `configTtlMs` per
 * isolate, so a request costs no extra D1 read. Turning protection on or off
 * calls `invalidate()` in the isolate that did it; other isolates follow
 * within `configTtlMs`.
 *
 * The hashed bundles under /assets/ are served before the Worker runs, so
 * this check covers what reaches the Worker: pages, server functions and
 * server routes, which carry all data. Access itself guards the bundles at
 * the edge.
 */

/**
 * Paths answered without an Access token: what the health check canaries and
 * the installer read, and the return from "Sign in with Cloudflare" (a form
 * appflare.dev posts, authorized by the sign-in an administrator started).
 */
export const ACCESS_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/api/health",
  "/api/cloudflare/oauth-return",
]);

export type AccessDenial = AccessJwtFailure | "settings-unavailable";

export interface AccessGateOptions {
  keys?: AccessKeyStore;
  now?: () => number;
  configTtlMs?: number;
  readConfig?: (db: D1Database) => Promise<AccessConfig | null>;
}

export interface AccessGate {
  /**
   * Null to let the request through; otherwise the response to send instead.
   * `version` (the running Appflare version) goes in the refusal page's footer.
   */
  check(request: Request, db: D1Database, version?: string): Promise<Response | null>;
  /** Drops the cached on/off state so the next request reads it again. */
  invalidate(): void;
}

export function createAccessGate(options: AccessGateOptions = {}): AccessGate {
  const keys = options.keys ?? createAccessKeyStore();
  const now = options.now ?? Date.now;
  const configTtlMs = options.configTtlMs ?? 15_000;
  const readConfig = options.readConfig ?? readAccessConfig;
  let cached: { config: AccessConfig | null; expiresAt: number } | null = null;

  async function currentConfig(db: D1Database): Promise<AccessConfig | null> {
    if (cached !== null && now() < cached.expiresAt) return cached.config;
    let config: AccessConfig | null;
    try {
      config = await readConfig(db);
    } catch (error) {
      // A failed read keeps the last known state for this isolate; with none,
      // the caller refuses the request.
      if (cached !== null) return cached.config;
      throw error;
    }
    cached = { config, expiresAt: now() + configTtlMs };
    return config;
  }

  return {
    async check(request, db, version) {
      const url = new URL(request.url);
      if (ACCESS_EXEMPT_PATHS.has(url.pathname)) return null;

      let config: AccessConfig | null;
      try {
        config = await currentConfig(db);
      } catch {
        return refuse("settings-unavailable", url, null, request, version);
      }
      if (config === null) return null;

      const result = await verifyAccessJwt(
        request.headers.get(ACCESS_JWT_HEADER),
        { aud: config.aud, teamDomain: config.teamDomain },
        keys.lookup(config.teamDomain),
        now(),
      );
      if (result.ok) return null;
      return refuse(result.reason, url, config, request, version);
    },
    invalidate() {
      cached = null;
    },
  };
}

function refuse(
  reason: AccessDenial,
  url: URL,
  config: AccessConfig | null,
  request: Request,
  version: string | undefined,
): Response {
  // The reason and path only: never the token, never the query string.
  console.warn(`access: refused ${request.method} ${url.pathname} (${reason})`);
  return accessDeniedResponse(reason, config, request, version);
}

/** The one gate the Worker uses; server functions invalidate it after a change. */
export const accessGate: AccessGate = createAccessGate();

const REASON_TEXT: Record<AccessDenial, { title: string; detail: string }> = {
  missing: {
    title: "Sign in with Cloudflare Access",
    detail:
      "This request did not come through Cloudflare Access, so Appflare did not answer it. Open the manager at its address and sign in when Access asks.",
  },
  expired: {
    title: "Your Access sign-in has expired",
    detail: "Reload the page to sign in with Cloudflare Access again.",
  },
  "not-yet-valid": {
    title: "Your Access sign-in is not valid yet",
    detail: "The sign-in token is dated in the future. Reload the page in a minute.",
  },
  "wrong-audience": {
    title: "This Access sign-in is for another application",
    detail:
      "The request carried a Cloudflare Access sign-in, but not one for this manager. This happens when the Access application for the manager was deleted or re-created in the Cloudflare dashboard.",
  },
  "wrong-issuer": {
    title: "This Access sign-in is from another team",
    detail:
      "The request carried a Cloudflare Access sign-in issued by a different Zero Trust team than the one this manager was set up with.",
  },
  "unknown-key": {
    title: "This Access sign-in could not be checked",
    detail:
      "It was signed with a key your Zero Trust team does not publish. Reload the page to sign in again.",
  },
  "bad-signature": {
    title: "This Access sign-in is not genuine",
    detail: "Its signature does not match your Zero Trust team's keys.",
  },
  malformed: {
    title: "This Access sign-in is not readable",
    detail: "The Cf-Access-Jwt-Assertion header is not a valid token.",
  },
  "unsupported-algorithm": {
    title: "This Access sign-in is not readable",
    detail: "The token is not signed the way Cloudflare Access signs tokens.",
  },
  "keys-unavailable": {
    title: "Appflare could not check your Access sign-in",
    detail:
      "It could not fetch your Zero Trust team's signing keys. Try again in a minute; nothing is served until the check succeeds.",
  },
  "settings-unavailable": {
    title: "Appflare could not check your Access sign-in",
    detail: "It could not read its own settings. Try again in a minute.",
  },
};

/**
 * The 403 answer: an HTML page for browsers, JSON with `code:
 * "access_denied"` for everything else. Server function calls get that JSON
 * as `application/problem+json`, so the app's client throws it (see
 * `denied.ts`) and the route error screen explains it.
 */
export function accessDeniedResponse(
  reason: AccessDenial,
  config: AccessConfig | null,
  request: Request,
  version?: string,
): Response {
  const { title, detail } = REASON_TEXT[reason];
  const headers = { "cache-control": "no-store" };
  const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
  if (!wantsHtml) {
    const body = {
      code: ACCESS_DENIED_CODE,
      error: `${title}. ${detail}`,
      reason,
      protectedBy: "Cloudflare Access",
    };
    const contentType =
      request.headers.get(SERVER_FN_HEADER) === "true"
        ? "application/problem+json"
        : "application/json";
    return new Response(JSON.stringify(body), {
      status: 403,
      headers: { ...headers, "content-type": contentType },
    });
  }
  const html = renderAccessDeniedPage({
    title,
    detail,
    address: config?.domain ? `https://${config.domain}/` : null,
    steps: accessRecoverySteps(config?.domain || new URL(request.url).hostname),
    version: version ?? null,
  });
  return new Response(html, {
    status: 403,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}
