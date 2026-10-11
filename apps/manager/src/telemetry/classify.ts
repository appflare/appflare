import {
  type AccountNames,
  NO_ACCOUNT_NAMES,
  REDACTED,
  REDACTED_DOMAIN,
  REDACTED_IP,
  REDACTED_NAME,
  redactReportText,
} from "./redact";

/**
 * Reduces a failed job's `jobs.error` to what usage data may carry: an error
 * category, the phase it failed in, the HTTP status and error code of a
 * Cloudflare API failure, and for such a failure a short excerpt of
 * Cloudflare's own message, filtered harder than a failure report
 * (`cloudflareMessage`). Appflare's text never leaves the manager: step
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
  "access_conflict",
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
  "access",
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
  /**
   * For a `cloudflare_*` category, Cloudflare's message after its `[code]`
   * (never the request's method, path or account id, nor Appflare's text
   * around it), filtered (`cloudflareMessage`) and at most
   * {@link CF_MESSAGE_MAX} characters. Null without this account's names.
   */
  cfMessage: string | null;
}

/** How much of Cloudflare's message a failure carries. */
export const CF_MESSAGE_MAX = 200;

/**
 * Step name patterns, first match wins. Ordered so the specific ones (a
 * sandbox build, a canary check) come before the general ones (a check, a
 * record).
 */
const PHASE_PATTERNS: readonly [RegExp, FailedPhase][] = [
  // First: "keep Worker <name> unreachable" carries a Worker name, which may
  // contain any word a later pattern looks for.
  [
    /Cloudflare Access|^keep Worker \S+ unreachable$|^Worker \S+ may be reachable$|^public paths back /,
    "access",
  ],
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
    /^(start|preflight checks|plan update|catalog keys|verify .*|load .* manifest|check (Worker names?|release shape|R2 is enabled|cron trigger limit|Workflow .*)|read current deployment)$/i,
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

const CLOUDFLARE_FAILURE =
  /Cloudflare API request failed: \S+ \S+ -> (\d{3})(?:: \[(\d+)\] ?([\s\S]*))?/;

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
  if (/^The Cloudflare Access application ".*" already covers /.test(message)) {
    return "access_conflict";
  }
  // Access refusals Appflare words itself, without Cloudflare's status: the
  // token lacks an Access permission, or the account has no Zero Trust.
  if (/^The Cloudflare token cannot (manage|read) /.test(message)) return "cloudflare_permission";
  if (
    /^This Cloudflare account has no Zero Trust organization|^This account has no workers\.dev subdomain|^The Zero Trust organization's team domain /.test(
      message,
    )
  ) {
    return "preflight";
  }
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

/**
 * Splits a failed job's error text into the step it failed in and the
 * message: the text before the first ": ". A D1 step names its binding
 * first and so has one more (`D1 DB: apply migrations`). The message itself
 * is never searched for a step: it may well mention a word a phase is known
 * by (a workers.dev hostname).
 */
export function splitJobError(error: string | null): { step: string; message: string } {
  const text = error ?? "";
  const first = text.indexOf(": ");
  if (first === -1) return { step: "", message: text };
  if (/^D1 \S+$/.test(text.slice(0, first))) {
    const second = text.indexOf(": ", first + 2);
    if (second !== -1) return { step: text.slice(0, second), message: text.slice(second + 2) };
  }
  return { step: text.slice(0, first), message: text.slice(first + 2) };
}

/**
 * Every Cloudflare API error code the texts mention, in order of first
 * appearance: the `[code]`s after `Cloudflare API request failed: … -> status:`.
 */
export function cloudflareErrorCodes(texts: readonly string[]): number[] {
  const codes: number[] = [];
  for (const text of texts) {
    for (const failure of text.matchAll(/Cloudflare API request failed: [^\n]*/g)) {
      for (const match of failure[0].matchAll(/\[(\d{3,6})\]/g)) {
        const code = Number(match[1]);
        if (!codes.includes(code)) codes.push(code);
      }
    }
  }
  return codes;
}

/**
 * Where Cloudflare's own text ends in `rest`, what followed its first
 * `[code] `: at the `)` closing the bracket Appflare opened before
 * "Cloudflare API request failed" (`… (${error.message}). …`), else at a
 * line break or a `; ` Appflare added after it (Cloudflare joins its own
 * errors with `; [code] `).
 */
function cloudflareDetail(text: string, match: RegExpExecArray): string {
  const rest = match[3] ?? "";
  if (text[match.index - 1] === "(") {
    let depth = 1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "(") depth += 1;
      else if (rest[i] === ")") {
        depth -= 1;
        if (depth === 0) return rest.slice(0, i);
      }
    }
    return rest;
  }
  const end = rest.search(/\n|; (?!\[\d+\] )/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Quoted text: whatever Cloudflare echoes of a request (a name, a statement). */
const QUOTED = /(?<![A-Za-z0-9])(?:"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)(?![A-Za-z0-9])/g;
/** Anything shaped like a hostname, a leading `*.` or `*-` included. */
const HOSTNAME_SHAPED =
  /(?<![A-Za-z0-9_.-])(?:\*[.-])?(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?\.)+[A-Za-z]{2,63}(?!\.?[A-Za-z0-9_-])/g;
/** Kept as written: Cloudflare's own error keys (`access.api.error.conflict`) and its own hostnames. */
const PUBLIC_DOTTED = /^(?:[a-z_]+\.api\.error\.[a-z_.]+|(?:[a-z]+\.)?cloudflare\.com)$/;
/** An IPv4 address (a port or prefix length after it stays). */
const IPV4 = /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?!\.?\w)/g;
/** An IPv6 address: eight groups, or fewer around a `::`, with a zone or not. */
const IPV6 =
  /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?)(?:%\w+)?(?![\w:])/gi;
/** A word, with the hyphens, underscores and dots inside it. */
const WORD = /(?<![\w.-])[\w-](?:[\w.-]*[\w-])?(?![\w-])/g;
/**
 * Kept although shaped like a name: an error constant in capitals
 * (`SQLITE_ERROR`, `D1_ERROR`, `UTF-8`), a number of up to six digits (an
 * HTTP status, an error code, a limit), with a size unit or not, a version
 * and a date.
 */
const PUBLIC_WORD =
  /^(?:[A-Z][A-Z0-9_-]*|\d{1,6}(?:\.\d{1,3})?(?:[KMGT]i?B|ms)?|v?\d{1,4}(?:\.\d{1,4}){1,2}|\d{4}-\d{2}-\d{2})$/;

/**
 * Masks every word shaped like a name someone chose (`acme-payroll-api`,
 * `acme_corp_prod`, `backups2026`): one of three characters or more with a
 * hyphen, an underscore or a digit, unless it is {@link PUBLIC_WORD}, one of
 * Cloudflare's error keys or a code in brackets (`[7500]`). A name written
 * as plain words (`Intranet Portal`) cannot be told from Cloudflare's own
 * words, and stays.
 */
function maskNameShaped(text: string): string {
  return text.replace(WORD, (word, at: number) => {
    if (word.length < 3 || !/[-_\d]/.test(word)) return word;
    if (PUBLIC_WORD.test(word) || PUBLIC_DOTTED.test(word)) return word;
    if (text[at - 1] === "[" && text[at + word.length] === "]") return word;
    return REDACTED_NAME;
  });
}

/**
 * Cloudflare's message (`cloudflareDetail`) with ids, email addresses and
 * secrets taken out, then every quoted text, everything shaped like a
 * hostname (a workers.dev address whole, its Worker's name included) and
 * every IP address, then this account's names wherever else they appear
 * (`redactReportText`), then every other word shaped like a name
 * (`maskNameShaped`), cut to {@link CF_MESSAGE_MAX} characters; null when
 * empty.
 */
function cloudflareMessage(detail: string, names: AccountNames): string | null {
  const masked = redactReportText(detail)
    .replace(QUOTED, (quoted) => `${quoted[0]}${REDACTED}${quoted[0]}`)
    .replace(HOSTNAME_SHAPED, (host) => (PUBLIC_DOTTED.test(host) ? host : REDACTED_DOMAIN))
    .replace(IPV4, REDACTED_IP)
    .replace(IPV6, REDACTED_IP);
  const clean = maskNameShaped(redactReportText(masked, names)).replace(/\s+/g, " ").trim();
  if (clean.length === 0) return null;
  return clean.length > CF_MESSAGE_MAX ? `${clean.slice(0, CF_MESSAGE_MAX - 1)}…` : clean;
}

/**
 * Classifies a failed job's error text. `names` are this account's own
 * names, which Cloudflare's message excerpt has taken out; null when they
 * could not be read, and then the excerpt is left out.
 */
export function classifyJobError(
  error: string | null,
  names: AccountNames | null = NO_ACCOUNT_NAMES,
): JobFailure {
  const text = error ?? "";
  const { step, message } = splitJobError(text);
  const cf = CLOUDFLARE_FAILURE.exec(text);
  const cfStatus = cf?.[1] === undefined ? null : Number(cf[1]);
  const cfCode = cf?.[2] === undefined ? null : Number(cf[2]);
  const phase = failedPhase(step);
  const errorCategory =
    categoryFromMessage(message, cfStatus, cfCode) ?? CATEGORY_BY_PHASE[phase] ?? "unknown";
  const cfMessage =
    cf !== null && names !== null && errorCategory.startsWith("cloudflare_")
      ? cloudflareMessage(cloudflareDetail(text, cf), names)
      : null;
  return { errorCategory, failedPhase: phase, cfStatus, cfCode, cfMessage };
}
