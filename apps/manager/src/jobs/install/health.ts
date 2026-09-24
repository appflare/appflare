import {
  appHealthMode,
  appHealthPath,
  artifactManifestSchema,
  catalogManifestSchema,
  type HealthMode,
} from "@appflare/schema";
import type { HealthStatus } from "../../db/schema";

/**
 * HTTP health checks of an app's Worker. The manager carries
 * `global_fetch_strictly_public`, so it can fetch its own account's
 * `*.workers.dev` hosts; right after the subdomain is enabled the route may not
 * have propagated yet (seconds, sometimes tens of seconds), which shows up as a
 * 404 whose body is `error code: 1042`, a DNS/connection error, or a transient
 * 5xx.
 *
 * Two kinds of check use this module. A canary (a version's preview URL,
 * before promotion) is attempt-bounded and fails its job when the version does
 * not serve: `classifyHealthProbe`. The live check (the Worker's own URL, after
 * the app was created or promoted) is time-bounded and never fails its job;
 * it records a `HealthStatus`: `decideLiveHealth`.
 *
 * Both read the answer by the app's health mode (`install.healthMode`). The
 * default counts redirects and 4xx answers as serving and a 5xx as a failure.
 * `status-only` is for apps whose every route sits behind Cloudflare Access
 * or their own sign-in: no request without credentials can show whether such
 * an app is healthy, so any answer the Worker itself gives counts, a 5xx of
 * its own included. Cloudflare's error pages (`error code: <n>`, such as 1042
 * while the route goes live or 1101 when the Worker crashed) are not the
 * Worker's answer and are judged as before, and a plain 404 still waits out
 * the window, since a route that is still going live can answer one too.
 */

export type { HealthMode } from "@appflare/schema";

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

/**
 * A page Cloudflare serves in the Worker's place (`error code: 1042`, `1101`,
 * ...): the edge answered, not the app.
 */
export function isEdgeErrorPage(probe: HealthProbe): boolean {
  return probe.kind === "response" && /^error code: \d+/.test(probe.bodyStart.trimStart());
}

/** Under `status-only`, whether this answer counts as the app serving. */
function statusOnlyPass(probe: HealthProbe, mode: HealthMode): boolean {
  return mode === "status-only" && probe.kind === "response" && !isEdgeErrorPage(probe);
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
  mode: HealthMode = "default",
): HealthVerdict {
  const last = attempt >= maxAttempts;
  if (probe.kind === "error" || isEdge1042(probe)) {
    return last
      ? { verdict: "unhealthy", reason: `${describe(probe)} after ${attempt} attempts` }
      : { verdict: "retry", reason: describe(probe) };
  }
  if (statusOnlyPass(probe, mode)) return { verdict: "healthy", status: probe.status };
  if (probe.status >= 500) {
    return !last && elapsedMs < HEALTH_5XX_GRACE_MS
      ? { verdict: "retry", reason: describe(probe) }
      : { verdict: "unhealthy", reason: `the Worker answered ${describe(probe)}` };
  }
  return { verdict: "healthy", status: probe.status };
}

/** How long the live check keeps probing, from its first probe. */
export const LIVE_HEALTH_WINDOW_MS = 90_000;

/** Waits between live probes: 2, 3, 5, 8, then 10 seconds for every later one. */
const LIVE_HEALTH_BACKOFF_SECONDS = [2, 3, 5, 8, 10] as const;

/** The wait in seconds after the live check's `attempt`th probe (1-based). */
export function liveHealthDelaySeconds(attempt: number): number {
  const i = Math.min(Math.max(attempt, 1), LIVE_HEALTH_BACKOFF_SECONDS.length) - 1;
  return LIVE_HEALTH_BACKOFF_SECONDS[i] ?? 10;
}

/** Scheduled waits before the `attempt`th probe, in milliseconds (0 for the first). */
export function liveHealthScheduledMs(attempt: number): number {
  let total = 0;
  for (let a = 1; a < attempt; a++) total += liveHealthDelaySeconds(a) * 1000;
  return total;
}

/**
 * What one live probe says: `pass` settles the check, `retry` keeps probing
 * (1042, no connection, 5xx), `soft-404` keeps probing too, but passes when
 * the window ends: an app may serve 404 at its root, and a plain 404 is also
 * what a route that is still propagating can answer.
 */
export type LiveProbeClass = "pass" | "retry" | "soft-404";

export function classifyLiveProbe(
  probe: HealthProbe,
  mode: HealthMode = "default",
): LiveProbeClass {
  if (probe.kind === "error" || isEdge1042(probe)) return "retry";
  if (probe.status === 404) return "soft-404";
  if (statusOnlyPass(probe, mode)) return "pass";
  if (probe.status >= 500) return "retry";
  return "pass";
}

export interface HealthSettlement {
  status: HealthStatus;
  /** What the last answer was, for the log and the install page. */
  detail: string;
}

/**
 * The health status one answer records when no more probes follow: any
 * non-5xx answer other than the 1042 page means the app serves (`verified`),
 * a 5xx means it serves errors (`unhealthy`), and no answer or the 1042 page
 * means it could not be reached (`unverified`).
 */
export function settleHealthProbe(
  probe: HealthProbe,
  mode: HealthMode = "default",
): HealthSettlement {
  if (probe.kind === "error" || isEdge1042(probe)) {
    return { status: "unverified", detail: describe(probe) };
  }
  if (statusOnlyPass(probe, mode)) return { status: "verified", detail: describe(probe) };
  if (probe.status >= 500) return { status: "unhealthy", detail: describe(probe) };
  return { status: "verified", detail: describe(probe) };
}

/** One line for a job's final log: "verified (HTTP 200)", "not verified yet (...)". */
export function healthLabel(s: HealthSettlement): string {
  const word = { verified: "verified", unverified: "not verified yet", unhealthy: "unhealthy" };
  return `${word[s.status]} (${s.detail})`;
}

export type LiveHealthDecision =
  | ({ done: true } & HealthSettlement)
  | { done: false; reason: string; delaySeconds: number };

/**
 * The live check's next move after its `attempt`th probe (1-based), taken
 * `elapsedMs` after the first. A passing answer settles at once; otherwise it
 * waits the next backoff delay unless that would pass the window, in which
 * case the last answer settles the check. `elapsedMs` never counts less than
 * the waits already scheduled, so the window also ends when the clock does
 * not move (the engine's sleeps make real time at least that long anyway).
 */
export function decideLiveHealth(
  probe: HealthProbe,
  attempt: number,
  elapsedMs: number,
  windowMs: number = LIVE_HEALTH_WINDOW_MS,
  mode: HealthMode = "default",
): LiveHealthDecision {
  if (classifyLiveProbe(probe, mode) === "pass") {
    return { done: true, ...settleHealthProbe(probe, mode) };
  }
  const delaySeconds = liveHealthDelaySeconds(attempt);
  const elapsed = Math.max(elapsedMs, liveHealthScheduledMs(attempt));
  if (elapsed + delaySeconds * 1000 > windowMs) {
    return { done: true, ...settleHealthProbe(probe, mode) };
  }
  return { done: false, reason: describe(probe), delaySeconds };
}

/** Where and how an install's health is checked. */
export interface HealthCheck {
  path: string;
  mode: HealthMode;
}

/**
 * The path health checks probe for an install and how they read the answer,
 * from its recorded manifest; `/` and the default mode when unknown.
 */
export function healthCheckOfManifest(manifestJson: string | null): HealthCheck {
  const fallback: HealthCheck = { path: "/", mode: "default" };
  if (manifestJson === null) return fallback;
  try {
    const json: unknown = JSON.parse(manifestJson);
    const parsed = artifactManifestSchema.safeParse(json);
    if (!parsed.success) {
      // A self-deploying install records its catalog manifest instead; its
      // app usually sits behind Cloudflare Access, so status-only is its default.
      const catalog = catalogManifestSchema.safeParse(json);
      if (!catalog.success || catalog.data.install.tier !== "self-deploying") return fallback;
      const { install } = catalog.data;
      return { path: appHealthPath(install), mode: install.healthMode ?? "status-only" };
    }
    const { install } = parsed.data.catalog;
    return { path: appHealthPath(install), mode: appHealthMode(install) };
  } catch {
    return fallback;
  }
}

/** The path health checks probe for an install, from its recorded manifest; `/` when unknown. */
export function healthPathOfManifest(manifestJson: string | null): string {
  return healthCheckOfManifest(manifestJson).path;
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
