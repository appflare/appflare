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
  | { kind: "response"; status: number; bodyStart: string }
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
    return { kind: "response", status: response.status, bodyStart: text.slice(0, 200) };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
