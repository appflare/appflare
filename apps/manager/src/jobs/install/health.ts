/**
 * The install's HTTP health check. The manager
 * carries `global_fetch_strictly_public`, so it can fetch its own account's
 * `*.workers.dev` hosts; right after the subdomain is enabled the route may not
 * have propagated yet (about 3 s), which shows up as a 404 whose body is
 * `error code: 1042`, a DNS/connection error, or a transient 5xx.
 */

export const HEALTH_MAX_ATTEMPTS = 10;
export const HEALTH_RETRY_DELAY = "2 seconds";
/** 5xx answers are retried only this long after the first probe. */
export const HEALTH_5XX_GRACE_MS = 20_000;

export type HealthProbe =
  | {
      kind: "response";
      status: number;
      bodyStart: string;
      /** The body up to {@link HEALTH_BODY_LIMIT} characters, for the version check. */
      body?: string;
    }
  | { kind: "error"; message: string };

export type HealthVerdict =
  | { verdict: "healthy"; status: number }
  | { verdict: "retry"; reason: string }
  | { verdict: "unhealthy"; reason: string };

export function isEdge1042(probe: HealthProbe): boolean {
  return (
    probe.kind === "response" &&
    probe.status === 404 &&
    probe.bodyStart.trimStart().startsWith("error code: 1042")
  );
}

function describe(probe: HealthProbe): string {
  if (probe.kind === "error") return `connection failed (${probe.message})`;
  if (isEdge1042(probe)) return "404 error code: 1042 (route not live yet)";
  return `HTTP ${probe.status}`;
}

/**
 * `attempt` is 1-based; `elapsedMs` is the time since the first probe. Retries
 * (while attempts remain) on 1042, connection errors, and 5xx within the grace
 * period; then any non-5xx answer is healthy.
 */
export function classifyHealthProbe(
  probe: HealthProbe,
  attempt: number,
  elapsedMs: number,
  maxAttempts: number = HEALTH_MAX_ATTEMPTS,
): HealthVerdict {
  const last = attempt >= maxAttempts;
  if (probe.kind === "error" || isEdge1042(probe)) {
    return last
      ? { verdict: "unhealthy", reason: `${describe(probe)} after ${attempt} attempts` }
      : { verdict: "retry", reason: describe(probe) };
  }
  if (probe.status >= 500) {
    return !last && elapsedMs < HEALTH_5XX_GRACE_MS
      ? { verdict: "retry", reason: describe(probe) }
      : { verdict: "unhealthy", reason: `the Worker answered ${describe(probe)}` };
  }
  return { verdict: "healthy", status: probe.status };
}

/** Health answers are small; anything longer is not a version report. */
export const HEALTH_BODY_LIMIT = 4096;

/**
 * The version rule of an update's check of the new version: when the app
 * answers JSON with a string `version` (as a health endpoint such as
 * `/api/health` does), it must equal the version being installed; any other
 * answer says nothing about the version, and the usual non-5xx rule decides.
 * Returns why the answer is wrong, or null.
 */
export function versionMismatch(probe: HealthProbe, expected: string): string | null {
  if (probe.kind !== "response" || probe.body === undefined) return null;
  let reported: unknown;
  try {
    reported = (JSON.parse(probe.body) as { version?: unknown } | null)?.version;
  } catch {
    return null;
  }
  if (typeof reported !== "string" || reported === expected) return null;
  return `the app reports version ${reported}, not ${expected}`;
}

/** GETs `url` once; never throws. Reads at most the start of the body. */
export async function probeHealth(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  timeoutMs = 10_000,
): Promise<HealthProbe> {
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Appflare health check" },
    });
    const text = await response.text();
    return {
      kind: "response",
      status: response.status,
      bodyStart: text.slice(0, 200),
      body: text.slice(0, HEALTH_BODY_LIMIT),
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
