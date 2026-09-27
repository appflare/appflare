/**
 * Reduces a failed job's `jobs.error` to what usage data may carry: an error
 * category, the phase it failed in, and the HTTP status and error code of a
 * Cloudflare API failure. The text itself never leaves the manager: step
 * names contain binding, resource and migration file names, and messages
 * contain paths, hostnames and ids.
 *
 * `jobs.error` reads `<step>: <message>` (every job's "mark failed" step), and
 * a Cloudflare failure's message reads
 * `Cloudflare API request failed: METHOD path -> status: [code] message`.
 */

export const ERROR_CATEGORIES = [
  "cloudflare_permission",
  "cloudflare_rate_limited",
  "cloudflare_unavailable",
  "cloudflare_rejected",
  "plan_limit",
  "subrequest_limit",
  "artifact_integrity",
  "artifact_fetch",
  "d1_migration",
  "name_conflict",
  "preflight",
  "sandbox_build",
  "installer",
  "canary",
  "timeout",
  "cancelled",
  "unknown",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const FAILED_PHASES = [
  "preflight",
  "resources",
  "assets",
  "upload",
  "canary",
  "d1_migrations",
  "secrets",
  "crons",
  "domains",
  "email_routing",
  "promote",
  "snapshot",
  "health",
  "sandbox",
  "installer",
  "delete",
  "record",
  "other",
] as const;
export type FailedPhase = (typeof FAILED_PHASES)[number];

export interface JobFailure {
  errorCategory: ErrorCategory;
  failedPhase: FailedPhase;
  cfStatus: number | null;
  cfCode: number | null;
}

/**
 * Step name patterns, first match wins. Ordered so the specific ones (a
 * sandbox build, a canary check) come before the general ones (a check, a
 * record).
 */
const PHASE_PATTERNS: readonly [RegExp, FailedPhase][] = [
  [/^D1 .*: (apply |seed$)|migration/i, "d1_migrations"],
  [/^canary (check|wait)|^skip canary$|version previews/i, "canary"],
  [/^health check|^skip health check$/i, "health"],
  [/build in sandbox|built manifest|clean up sandbox builds|^prepare build request$/i, "sandbox"],
  [
    /installer|in sandbox$|app token|app secret|from the sandbox Worker|^skip destroy$/i,
    "installer",
  ],
  [/^check sandbox Worker$/i, "sandbox"],
  [/bookmark|snapshot/i, "snapshot"],
  [/custom domain|workers\.dev/i, "domains"],
  [/email routing|mail at|^route .* to the Worker$/i, "email_routing"],
  [/^set cron triggers$/i, "crons"],
  [/^set secret /i, "secrets"],
  [/assets/i, "assets"],
  [
    /^promote version$|^mark promotion$|^record promotion$|^deploy (Worker script|snapshot version)$/i,
    "promote",
  ],
  [/^upload Worker|^read current bindings$|^record (new|Worker) version$/i, "upload"],
  [/^(delete|empty) |^remove consumer|resources deleted$/i, "delete"],
  [
    /^(start|preflight checks|plan update|verify .*|load .* manifest|check (Worker names?|release shape|R2 is enabled|cron trigger limit|Workflow .*)|read current deployment)$/i,
    "preflight",
  ],
  [
    /^(create|check) |consumer|rate limit namespaces|Durable Object classes|the app's resources/i,
    "resources",
  ],
  [/^record |^finish$/i, "record"],
];

/** The phase a step name belongs to; `other` for anything unrecognised. */
export function failedPhase(step: string): FailedPhase {
  for (const [pattern, phase] of PHASE_PATTERNS) {
    if (pattern.test(step)) return phase;
  }
  return "other";
}

const CLOUDFLARE_FAILURE = /Cloudflare API request failed: \S+ \S+ -> (\d{3})(?:: \[(\d+)\])?/;

/** Workers Free's cron trigger limit and Cloudflare's script size refusal. */
const PLAN_LIMIT_CODES = new Set([10072, 10027]);

function categoryFromMessage(
  message: string,
  cfStatus: number | null,
  cfCode: number | null,
): ErrorCategory | null {
  if (/too many subrequests|subrequests per Worker invocation/i.test(message)) {
    return "subrequest_limit";
  }
  if (
    (cfCode !== null && PLAN_LIMIT_CODES.has(cfCode)) ||
    /cron triggers per account|needs Workers Paid|script (is )?too large|exceeds? .*size limit/i.test(
      message,
    )
  ) {
    return "plan_limit";
  }
  if (/already exists in this account/i.test(message)) return "name_conflict";
  if (
    /signature|digest [0-9a-f]+ does not match|sha256 [0-9a-f]+ does not match|not a valid artifact manifest|^the artifact is (for|version)|got \d+ bytes, expected/i.test(
      message,
    )
  ) {
    return "artifact_integrity";
  }
  if (/^GET \S+ (-> \d{3}|failed)/.test(message)) return "artifact_fetch";
  if (/terminated|cancell?ed/i.test(message)) return "cancelled";
  if (/timed? ?out/i.test(message)) return "timeout";
  if (cfStatus === 401 || cfStatus === 403) return "cloudflare_permission";
  if (cfStatus === 429) return "cloudflare_rate_limited";
  if (cfStatus !== null && cfStatus >= 500) return "cloudflare_unavailable";
  if (cfStatus !== null && cfStatus >= 400) return "cloudflare_rejected";
  return null;
}

const CATEGORY_BY_PHASE: Partial<Record<FailedPhase, ErrorCategory>> = {
  d1_migrations: "d1_migration",
  canary: "canary",
  sandbox: "sandbox_build",
  installer: "installer",
  preflight: "preflight",
};

/** Classifies a failed job's error text. */
export function classifyJobError(error: string | null): JobFailure {
  const text = error ?? "";
  // A step name may itself contain ": " (`D1 DB: apply migrations`), so the
  // first prefix that names a known phase is the step.
  let step = "";
  let message = text;
  for (let at = text.indexOf(": "), tries = 0; at !== -1 && tries < 3; tries++) {
    const candidate = text.slice(0, at);
    if (tries === 0 || failedPhase(candidate) !== "other") {
      step = candidate;
      message = text.slice(at + 2);
      if (failedPhase(candidate) !== "other") break;
    }
    at = text.indexOf(": ", at + 2);
  }
  const cf = CLOUDFLARE_FAILURE.exec(text);
  const cfStatus = cf?.[1] === undefined ? null : Number(cf[1]);
  const cfCode = cf?.[2] === undefined ? null : Number(cf[2]);
  const phase = failedPhase(step);
  const errorCategory =
    categoryFromMessage(message, cfStatus, cfCode) ?? CATEGORY_BY_PHASE[phase] ?? "unknown";
  return { errorCategory, failedPhase: phase, cfStatus, cfCode };
}
