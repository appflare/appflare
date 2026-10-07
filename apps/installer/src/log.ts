/**
 * The installer's log lines. They never carry a token, an account id, a
 * hostname or any name a visitor chose: Cloudflare requests are logged as
 * method, a path whose every variable segment is replaced by `:id`, and
 * status; other events as fixed words and numbers.
 */

/** Segments of Cloudflare API paths that are part of the API, not data. */
const API_WORDS: ReadonlySet<string> = new Set([
  "accounts",
  "assets",
  "assets-upload-session",
  "d1",
  "database",
  "deployments",
  "dns_records",
  "domains",
  "kv",
  "memberships",
  "namespaces",
  "query",
  "routes",
  "schedules",
  "scripts",
  "secrets",
  "settings",
  "storage",
  "subdomain",
  "tokens",
  "upload",
  "user",
  "verify",
  "versions",
  "workers",
  "workflows",
  "zones",
]);

/** `/accounts/abc/workers/scripts/my-name` -> `/accounts/:id/workers/scripts/:id`. */
export function redactPath(path: string): string {
  const bare = path.split("?")[0] ?? "";
  return bare
    .split("/")
    .map((segment) => (segment === "" || API_WORDS.has(segment) ? segment : ":id"))
    .join("/");
}

type Fields = Record<string, string | number | boolean | null>;

export function logEvent(event: string, fields: Fields = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export function logError(event: string, fields: Fields = {}): void {
  console.error(JSON.stringify({ event, ...fields }));
}

export function logCloudflareRequest(log: { method: string; path: string; status: number }): void {
  logEvent("cloudflare", { method: log.method, path: redactPath(log.path), status: log.status });
}
