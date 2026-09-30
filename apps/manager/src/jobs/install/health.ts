import { isAccessTeamDomain } from "@appflare/cf-api";
import {
  artifactManifestSchema,
  catalogManifestSchema,
  DEFAULT_HEALTH_MODE,
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
 * Both read the answer by the app's health mode (`install.health.mode`). The
 * default, `no-server-errors`, counts redirects and 4xx answers as serving and a 5xx as a failure.
 * `any-response` is for apps whose every route asks for a sign-in, their own
 * or one they check from Cloudflare Access: no request without credentials
 * can show whether such an app is healthy, so any answer the Worker itself
 * gives counts, a 5xx of its own included. Cloudflare's error pages
 * (`error code: <n>`, such as 1042 while the route goes live or 1101 when the
 * Worker crashed) are not the Worker's answer and are judged as before, and a
 * plain 404 still waits out the window, since a route that is still going
 * live can answer one too. The exception is a settings change: the app's URL
 * was serving before that job, so no route is going live and a plain 404 is
 * the app's own answer; its live check passes one at once (`routeWasLive`).
 *
 * Cloudflare Access's own sign-in redirect is not the Worker's answer either,
 * in any mode (`isAccessChallenge`): Access answers before the request reaches
 * the Worker, so the check learns nothing about the app. The live check
 * records it as `unverified` at once, a canary reports it as `blocked` (the
 * new version could not be checked, which does not fail the job), and a
 * domain check does not count it as the domain serving the app.
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
      /** The `Location` header, when the answer has one (see `isAccessChallenge`). */
      location?: string;
    }
  | { kind: "error"; message: string };

/**
 * `blocked`: Cloudflare Access answered in the Worker's place, so the check
 * never reached the app and says nothing about it either way.
 */
export type HealthVerdict =
  | { verdict: "healthy"; status: number }
  | { verdict: "retry"; reason: string }
  | { verdict: "unhealthy"; reason: string }
  | { verdict: "blocked"; reason: string };

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

/**
 * Cloudflare Access answering in the Worker's place: a redirect to the
 * team's sign-in page, `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?...`.
 * A request without an Access session to a protected workers.dev host, the
 * Worker's own URL and its version preview URLs alike, was seen to get this
 * 302 from the edge. Other answers Access may give (a 401 or 403 page) are
 * not recognised: none has been seen for a plain GET.
 */
export function isAccessChallenge(probe: HealthProbe): boolean {
  if (probe.kind !== "response" || probe.status < 300 || probe.status > 399) return false;
  if (probe.location === undefined) return false;
  let target: URL;
  try {
    target = new URL(probe.location);
  } catch {
    return false;
  }
  return (
    target.protocol === "https:" &&
    target.port === "" &&
    isAccessTeamDomain(target.hostname) &&
    target.pathname.startsWith("/cdn-cgi/access/")
  );
}

/** How an Access sign-in redirect is described in logs and on the app page. */
export const ACCESS_CHALLENGE_DETAIL = "Cloudflare Access asked for a sign-in";

/** Under `any-response`, whether this answer counts as the app serving. */
function anyResponsePass(probe: HealthProbe, mode: HealthMode): boolean {
  return mode === "any-response" && probe.kind === "response" && !isEdgeErrorPage(probe);
}

function describe(probe: HealthProbe): string {
  if (probe.kind === "error") return `connection failed (${probe.message})`;
  if (isEdge1042(probe)) return "404 error code: 1042 (route not live yet)";
  if (isAccessChallenge(probe)) return ACCESS_CHALLENGE_DETAIL;
  return `HTTP ${probe.status}`;
}

/**
 * `attempt` is 1-based; `elapsedMs` is the time since the first probe. Retries
 * (while attempts remain) on 1042, connection errors, and 5xx within the grace
 * period; then any non-5xx answer is healthy. Cloudflare Access's sign-in
 * redirect is `blocked` at once: Access keeps answering until someone changes
 * its policy, so waiting would not reach the app.
 */
export function classifyHealthProbe(
  probe: HealthProbe,
  attempt: number,
  elapsedMs: number,
  maxAttempts: number = HEALTH_MAX_ATTEMPTS,
  mode: HealthMode = DEFAULT_HEALTH_MODE,
): HealthVerdict {
  const last = attempt >= maxAttempts;
  if (probe.kind === "error" || isEdge1042(probe)) {
    return last
      ? { verdict: "unhealthy", reason: `${describe(probe)} after ${attempt} attempts` }
      : { verdict: "retry", reason: describe(probe) };
  }
  if (isAccessChallenge(probe)) return { verdict: "blocked", reason: describe(probe) };
  if (anyResponsePass(probe, mode)) return { verdict: "healthy", status: probe.status };
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
 * what a route that is still propagating can answer. When the route was
 * already live before the job (a settings change keeps the URL that was
 * serving), a plain 404 cannot be propagation, so it is the app's own answer
 * and passes at once. `blocked` settles the check too, as `unverified`:
 * Cloudflare Access answered in the app's place, and it keeps doing so for the
 * rest of the window, so probing on would only use the window up.
 */
export type LiveProbeClass = "pass" | "retry" | "soft-404" | "blocked";

export function classifyLiveProbe(
  probe: HealthProbe,
  mode: HealthMode = DEFAULT_HEALTH_MODE,
  routeWasLive = false,
): LiveProbeClass {
  if (probe.kind === "error" || isEdge1042(probe)) return "retry";
  if (isAccessChallenge(probe)) return "blocked";
  if (probe.status === 404) return routeWasLive && !isEdgeErrorPage(probe) ? "pass" : "soft-404";
  if (anyResponsePass(probe, mode)) return "pass";
  if (probe.status >= 500) return "retry";
  return "pass";
}

export interface HealthSettlement {
  status: HealthStatus;
  /** What the last answer was, for the log and the install page. */
  detail: string;
  /** Set when Cloudflare Access answered in the app's place (`isAccessChallenge`). */
  access?: true;
}

/**
 * The health status one answer records when no more probes follow: any
 * non-5xx answer other than the 1042 page means the app serves (`verified`),
 * a 5xx means it serves errors (`unhealthy`), and no answer, the 1042 page or
 * Cloudflare Access's sign-in redirect means it could not be reached
 * (`unverified`).
 */
export function settleHealthProbe(
  probe: HealthProbe,
  mode: HealthMode = DEFAULT_HEALTH_MODE,
): HealthSettlement {
  if (probe.kind === "error" || isEdge1042(probe)) {
    return { status: "unverified", detail: describe(probe) };
  }
  if (isAccessChallenge(probe)) {
    return { status: "unverified", detail: describe(probe), access: true };
  }
  if (anyResponsePass(probe, mode)) return { status: "verified", detail: describe(probe) };
  if (probe.status >= 500) return { status: "unhealthy", detail: describe(probe) };
  return { status: "verified", detail: describe(probe) };
}

/**
 * The install columns a settled check writes. `health_access` is written
 * every time, so a check that reaches the app clears an earlier Access answer.
 */
export function healthColumns(
  settled: HealthSettlement,
  checkedAt: Date,
): { health_status: HealthStatus; health_access: boolean; health_checked_at: Date } {
  return {
    health_status: settled.status,
    health_access: settled.access === true,
    health_checked_at: checkedAt,
  };
}

/**
 * Whether an install's recorded health is Cloudflare Access answering in the
 * app's place. Only with `unverified`: a manager from before `health_access`
 * rewrites the status and leaves the flag as it was.
 */
export function healthBehindAccess(
  status: HealthStatus | null,
  access: boolean | null | undefined,
): boolean {
  return status === "unverified" && access === true;
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
 * `elapsedMs` after the first. A passing answer, or Cloudflare Access's
 * sign-in redirect (as `unverified`), settles at once; otherwise it
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
  mode: HealthMode = DEFAULT_HEALTH_MODE,
  /** The URL served before the job, so a plain 404 is the app's answer (see `classifyLiveProbe`). */
  routeWasLive = false,
): LiveHealthDecision {
  const kind = classifyLiveProbe(probe, mode, routeWasLive);
  if (kind === "pass" || kind === "blocked") {
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
  const fallback: HealthCheck = { path: "/", mode: DEFAULT_HEALTH_MODE };
  if (manifestJson === null) return fallback;
  try {
    const json: unknown = JSON.parse(manifestJson);
    const parsed = artifactManifestSchema.safeParse(json);
    if (!parsed.success) {
      // A self-deploying install records its catalog manifest instead.
      const catalog = catalogManifestSchema.safeParse(json);
      if (!catalog.success || catalog.data.install.tier !== "self-deploying") return fallback;
      const { install } = catalog.data;
      return { path: install.health.path, mode: install.health.mode };
    }
    const { install } = parsed.data.catalog;
    return { path: install.health.path, mode: install.health.mode };
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

/**
 * Extra request headers for a health check of `url`: a protected install's
 * own service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) when
 * the URL is one of that install's addresses (access/probe-credentials.server.ts),
 * otherwise undefined. Never throws.
 */
export type ProbeHeadersFor = (url: string) => Promise<Record<string, string> | undefined>;

/** {@link ProbeHeadersFor}, for the install `installId`: only its own token, only to its own addresses. */
export type InstallProbeHeaders = (
  installId: string,
  url: string,
) => Promise<Record<string, string> | undefined>;

export interface ProbeOptions {
  timeoutMs?: number;
  /** Added to the request, such as {@link ProbeHeadersFor}'s answer. */
  headers?: Record<string, string>;
}

/**
 * Whether `probe` is Cloudflare Access's sign-in for `url`'s own host: an
 * {@link isAccessChallenge} whose login path names that host
 * (`/cdn-cgi/access/login/<host>`). Only then is Access known to be in front
 * of that host right now, and so to strip a service token's headers before
 * the Worker sees them.
 */
export function isAccessChallengeFor(probe: HealthProbe, url: string): boolean {
  if (!isAccessChallenge(probe) || probe.kind !== "response" || probe.location === undefined) {
    return false;
  }
  let host: string;
  let path: string;
  try {
    host = new URL(url).hostname.toLowerCase();
    path = new URL(probe.location).pathname;
  } catch {
    return false;
  }
  return (
    path === `/cdn-cgi/access/login/${host}` || path.startsWith(`/cdn-cgi/access/login/${host}/`)
  );
}

/**
 * A health check of a URL that may be behind Cloudflare Access: first
 * without credentials; only when that answer is Access's sign-in for the
 * same host ({@link isAccessChallengeFor}) are `credentials` asked for, and
 * sent in one more probe of the same URL. So a token never reaches a Worker
 * that answers for itself (Access is not in front of it), whatever Access
 * settings say, and no token is even looked up while none is needed.
 */
export async function probeHealthThroughAccess(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  credentials?: () => Promise<Record<string, string> | undefined>,
  options: Omit<ProbeOptions, "headers"> = {},
): Promise<HealthProbe> {
  const first = await probeHealth(fetchImpl, url, options);
  if (credentials === undefined || !isAccessChallengeFor(first, url)) return first;
  const headers = await credentials();
  if (headers === undefined) return first;
  return probeHealth(fetchImpl, url, { ...options, headers });
}

/**
 * GETs `url` once; never throws. Reads at most the start of the body.
 * Redirects are never followed (`redirect: "manual"`), so `headers` only
 * ever reach `url`'s own host.
 */
export async function probeHealth(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  options: ProbeOptions = {},
): Promise<HealthProbe> {
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { ...options.headers, "user-agent": "Appflare health check" },
    });
    const text = await response.text();
    const location = response.headers.get("location");
    return {
      kind: "response",
      status: response.status,
      bodyStart: text.slice(0, 200),
      body: text.slice(0, HEALTH_BODY_LIMIT),
      ...(location === null ? {} : { location }),
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
