import { type AccessConfig, readAccessConfig } from "./config";
import { ACCESS_JWT_HEADER, type AccessJwtFailure, verifyAccessJwt } from "./jwt";
import { type AccessKeyStore, createAccessKeyStore } from "./keys";
import { ACCESS_RECOVERY_COMMAND, accessRecoverySteps } from "./recovery";

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
 * Static assets (the SPA shell and bundles) are served before the Worker runs,
 * so this check covers what reaches the Worker: server functions and server
 * routes, which carry all data. Access itself guards the assets at the edge.
 */

/** Paths answered without an Access token: the health check canaries and `appflare status` read. */
export const ACCESS_EXEMPT_PATHS: ReadonlySet<string> = new Set(["/api/health"]);

export type AccessDenial = AccessJwtFailure | "settings-unavailable";

export interface AccessGateOptions {
  keys?: AccessKeyStore;
  now?: () => number;
  configTtlMs?: number;
  readConfig?: (db: D1Database) => Promise<AccessConfig | null>;
}

export interface AccessGate {
  /** Null to let the request through; otherwise the response to send instead. */
  check(request: Request, db: D1Database): Promise<Response | null>;
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
    async check(request, db) {
      const url = new URL(request.url);
      if (ACCESS_EXEMPT_PATHS.has(url.pathname)) return null;

      let config: AccessConfig | null;
      try {
        config = await currentConfig(db);
      } catch {
        return refuse("settings-unavailable", url, null, request);
      }
      if (config === null) return null;

      const result = await verifyAccessJwt(
        request.headers.get(ACCESS_JWT_HEADER),
        { aud: config.aud, teamDomain: config.teamDomain },
        keys.lookup(config.teamDomain),
        now(),
      );
      if (result.ok) return null;
      return refuse(result.reason, url, config, request);
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
): Response {
  // The reason and path only: never the token, never the query string.
  console.warn(`access: refused ${request.method} ${url.pathname} (${reason})`);
  return accessDeniedResponse(reason, config, request);
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The 403 answer: an HTML page for browsers, JSON for everything else. */
export function accessDeniedResponse(
  reason: AccessDenial,
  config: AccessConfig | null,
  request: Request,
): Response {
  const { title, detail } = REASON_TEXT[reason];
  const headers = { "cache-control": "no-store" };
  const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
  if (!wantsHtml) {
    return Response.json(
      { error: `${title}. ${detail}`, reason, protectedBy: "Cloudflare Access" },
      { status: 403, headers },
    );
  }
  const address = config?.domain ? `https://${config.domain}/` : null;
  const [step1, step2] = accessRecoverySteps(config?.domain || new URL(request.url).hostname);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Appflare</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
  body { margin: 0; padding: 4rem 1.5rem; }
  main { max-width: 36rem; margin: 0 auto; }
  h1 { font-size: 1.375rem; margin: 0 0 0.75rem; }
  p, ol { margin: 0 0 1rem; }
  li { margin: 0 0 0.5rem; }
  .muted { opacity: 0.75; font-size: 0.875rem; }
  code { font-size: 0.8125rem; word-break: break-all; }
</style>
</head>
<body>
<main>
<p class="muted">Appflare · protected by Cloudflare Access</p>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p>
${address === null ? "" : `<p><a href="${escapeHtml(address)}">Open the manager</a></p>`}
<p class="muted">Locked out? An admin turns Access protection off in Settings. If Settings cannot be reached:</p>
<ol class="muted">
<li>${escapeHtml(step1)}</li>
<li>${escapeHtml(step2)}<br><code>${escapeHtml(ACCESS_RECOVERY_COMMAND)}</code></li>
</ol>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 403,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}
