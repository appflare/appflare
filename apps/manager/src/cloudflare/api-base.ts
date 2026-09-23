/**
 * `CF_API_BASE_URL` points the Cloudflare API client at a local fake (tests,
 * `scripts/fake-cloudflare-api.mjs`). The account token travels with every call,
 * so the override is honoured ONLY for loopback hosts; anything else is ignored
 * with a warning and the real API base is used.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

/** The override to pass as cf-api `baseUrl`, or undefined for the real API. */
export function apiBaseOverride(env: { CF_API_BASE_URL?: string }): string | undefined {
  const value = env.CF_API_BASE_URL?.trim();
  if (!value) return undefined;
  if (isLoopbackUrl(value)) return value;
  console.warn("CF_API_BASE_URL ignored: only loopback hosts are allowed");
  return undefined;
}

/** `{ baseUrl }` to spread into cf-api client options, or nothing. */
export function apiBaseOption(env: { CF_API_BASE_URL?: string }): { baseUrl?: string } {
  const baseUrl = apiBaseOverride(env);
  return baseUrl === undefined ? {} : { baseUrl };
}
