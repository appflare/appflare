import { ADDRESS_ANSWERS, type AddressAnswer, addressAnswerOf } from "../domains/address-answer";
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
 * category, the phase it failed in, for some failures a reason from a fixed
 * list (`FAILURE_REASONS`), the HTTP status and error code of a
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
  "address_not_serving",
  "account_setup",
  "connection",
  "external_change",
  "install_state",
  "input_missing",
  "sandbox_unavailable",
  "cloudflare_unexpected",
  "database_connection",
  "delete_incomplete",
  "busy",
  "workflow_limit",
  "job_stopped",
  "manager_database",
  "internal",
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
  "address",
  "pause",
  "sandbox",
  "installer",
  "delete",
  "record",
  "other",
] as const;
export type FailedPhase = (typeof FAILED_PHASES)[number];

/**
 * Why a job failed, in more detail than its category, from a fixed list:
 * for a failure in the preflight (the checks before anything is created),
 * which check refused it; for a move of Appflare's address whose new address
 * never answered as this Appflare, what answered instead
 * (`ADDRESS_ANSWERS`, domains/address-answer.ts). Never the message itself.
 */
export const PREFLIGHT_REASONS = [
  "plan_paid_required",
  "cost_unconfirmed",
  "requirements_unconfirmed",
  "token_permission_missing",
  "connection_needed",
  "account_unknown",
  "account_limit",
  "cron_limit",
  "job_too_big",
  "name_taken",
  "r2_not_enabled",
  "zero_trust_missing",
  "workers_dev_missing",
  "email_zone_unusable",
  "sandbox_required",
  "release_mismatch",
  "manifest_invalid",
  "artifact_unavailable",
  "catalog_removed",
  "app_unsupported",
  "input_missing",
  "install_state",
  "deployment_in_progress",
  "deleted_outside",
  "changed_outside",
  "cloudflare_unavailable",
  "cloudflare_rejected",
  "preflight_other",
] as const;
export type PreflightReason = (typeof PREFLIGHT_REASONS)[number];

export const FAILURE_REASONS = [...PREFLIGHT_REASONS, ...ADDRESS_ANSWERS] as const;
export type FailureReason = PreflightReason | AddressAnswer;

export interface JobFailure {
  errorCategory: ErrorCategory;
  failedPhase: FailedPhase;
  /** {@link FAILURE_REASONS}: for a preflight failure and an address that never answered; else null. */
  failureReason: FailureReason | null;
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
  // A pause or resume reads the app's Workers (and a pause its Durable
  // Objects) before it changes anything; "read Worker <name>" and "read
  // what Worker <name> serves" carry a Worker name too. The undo of a
  // pause reads them again ("undo: read what …"), in the pause phase.
  [
    /^read Worker \S+$|^read what Worker \S+ serves$|^read the app's Durable Objects$|^check the app's Workers$/,
    "preflight",
  ],
  // Then, anchored at their fixed start: the steps of moving Appflare's
  // address and of pausing and resuming an app carry hostnames and Worker,
  // queue and Workflow names, which may contain any word a later pattern
  // looks for.
  [
    /^(Waiting for the certificate and the new address|Switching the address|Detaching the old domain)( \(|$)/,
    "address",
  ],
  [
    /^(undo: read what Worker \S+ serves$|(undo: )?(upload the stand-ins? of Workers? |find the app's queues$|(pause|resume) delivery of |list running instances of Workflow |(pause|resume) instances of Workflow |serve the stand-in of Worker |serve the app's version of Worker |(stop|allow) container instances of ))/,
    "pause",
  ],
  // Uninstall steps that carry a domain, binding, address or Worker name, which may
  // contain any word a later pattern looks for.
  [/^remove (external|wildcard) domain |^remove gateway binding /, "domains"],
  [/^(remove|forget) email route |^restore catch-all /, "email_routing"],
  [/^skip Worker /, "delete"],
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
    /^(start|preflight checks|plan update|plan settings change|plan Email Routing again|catalog keys|verify .*|load .* manifest|check (Worker names?|release shape|R2 is enabled|[A-Za-z0-9 ]+ limit|Workflow .*|Email Routing|Pipelines.*|access to the Cloudflare account|account)|read current deployment( \(Worker ".*"\))?)$/i,
    "preflight",
  ],
  [
    /^(create|check) |consumer|rate limit namespaces|Durable Object classes|the app's resources/i,
    "resources",
  ],
  [/^record |^finish$/i, "record"],
];

/**
 * A step a job runs before another, or again, belongs to that step's phase:
 * the wait for a fresh invocation on Workers Free, and a step that ran out
 * of its invocation's requests run once more.
 */
const AROUND_STEP = /^wait for a fresh invocation before (.+?)(?: again)?$|^(.+) \(again\)$/;

/** The step a step run before or again belongs to ({@link AROUND_STEP}); else the step itself. */
function failedStepName(step: string): string {
  const around = AROUND_STEP.exec(step);
  return around === null ? step : (around[1] ?? around[2] ?? step);
}

/** The phase a step name belongs to; `other` for anything unrecognised. */
export function failedPhase(step: string): FailedPhase {
  const name = failedStepName(step);
  for (const [pattern, phase] of PHASE_PATTERNS) {
    if (pattern.test(name)) return phase;
  }
  return "other";
}

const CLOUDFLARE_FAILURE =
  /Cloudflare API request failed: \S+ \S+ -> (\d{3})(?:: \[(\d+)\] ?([\s\S]*))?/;

/** Workers Free's cron trigger limit, Cloudflare's script size refusal, and an account limit reached. */
const PLAN_LIMIT_CODES = new Set([10072, 10027, 7406]);

/**
 * Failures Appflare words itself, by what they mean, checked in order after
 * the ones above them in {@link categoryFromMessage}. Each pattern is written
 * against the job's own message (the text after the step).
 */
const MESSAGE_CATEGORIES: readonly [RegExp, ErrorCategory][] = [
  // Another change holds what this one needs (the address lock).
  [/already being changed\. Try again in a minute\./, "busy"],
  // The connection to Cloudflare needs an administrator, or is renewing (cloudflare/connection-errors.ts).
  [
    /^the Cloudflare API token is not configured|^Cloudflare no longer accepts Appflare's connection|cannot read its saved connection to Cloudflare|still redeploying itself with its new Cloudflare connection|could not renew its access to Cloudflare|renewing its access to Cloudflare in another request|^Cloudflare refused to renew Appflare's access/,
    "connection",
  ],
  // Something the account must offer first: R2, a zone for mail.
  [
    /^R2 is not enabled on this|is not active on Cloudflare yet|does not use Cloudflare DNS|belongs to another Cloudflare account|receives its mail elsewhere/,
    "account_setup",
  ],
  // Someone changed the app outside Appflare since it last looked.
  [
    /a gradual deployment is in progress|was uploaded after this job's version|serves a stand-in of an earlier pause|is gone at Cloudflare|has since been deleted|has no deployment, so there is nothing to pause|lacks Durable Object migrations up to/,
    "external_change",
  ],
  // The sandbox Worker is missing, outdated or busy (not a build that ran and failed).
  [
    /Appflare is not connected to (it|one|a sandbox Worker|the sandbox Worker)|^the sandbox Worker \S+ (cannot |speaks protocol )|^the sandbox Worker answered \S+ with an unexpected shape|^sandbox builds (could not be turned on|are on now|are still being turned on)|^the job \S+ that turns sandbox builds on|^the sandbox Worker is busy with|^Sandbox builds are in use by|has no SELF binding|^the SANDBOX binding went away/,
    "sandbox_unavailable",
  ],
  // Cloudflare answered, but not with what it should have.
  [
    /^Cloudflare (did not (report|return|answer with)|asked for an asset|serves no preview)/,
    "cloudflare_unexpected",
  ],
  // An app's database connection (Hyperdrive) cannot be made.
  [
    /^Cloudflare could not set up Hyperdrive for |^the connection string for \S+ is not usable|^no connection string was given for/,
    "database_connection",
  ],
  // A removal that could not finish in one run.
  [
    /^one run deletes at most \d+|is still listed after it was deleted|cannot be deleted through the Cloudflare API because its key/,
    "delete_incomplete",
  ],
  // The install or its pause is not in a state the job can run from.
  [
    /^the install (no longer exists|is \w+, not |is not uninstalled|was not deployed by|never got as far|is being removed)|^only an installed app can be|^the app is (not|already) paused|^another pause of the app|^the app's pause closed|^the snapshot does not belong|^a catalog install cannot be replaced|^the job \S+ that removes the failed install|^what the install that did not finish left|^the install that did not finish is still being removed/,
    "install_state",
  ],
  // Something the job needs from the admin was not given.
  [
    /^[Nn]o value was provided for |^this app receives email; choose a zone|takes no zone/,
    "input_missing",
  ],
  // Appflare's own invariants: what it planned does not fit what it found.
  [
    /^no (version of|queue resource is known|API token was given)|^(service|workflow|rate limit) binding \S+ (does not point|has props|has no)|^binding \S+ (names a Worker|\(.*\) has no created resource)|^an upload without modules|^the Worker serves static assets only|still has .* to apply after \d+ calls|^this Worker has no D1 binding|has no Durable Object namespace for|^no namespace for |^the stream of \S+ is created with|is not a function$|has no callback$|ran \d+ of \d+ seed statements/,
    "internal",
  ],
];

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
    /cron triggers per account|needs? (the )?Workers Paid\b|script (is )?too large|exceeds? .*size limit|Workers (Free|Paid) allows [\d,]+ (\w+ )?per (account|job)|limit of [\d,]+ [A-Za-z0-9 ]+ per account|but Appflare uploads at most|subrequests to read its \d+ Worker modules|but Cloudflare allows \d+ on an index|would pass Cloudflare's limit of \d+/i.test(
      message,
    )
  ) {
    return "plan_limit";
  }
  if (
    /already exists in this account|already uses the Worker name "|is already installed as "|only works as the Worker "|is not an Appflare sandbox Worker|already serves (another Worker|the Worker ")|is already a custom domain of this app|^the install was claimed as "|serves the app from "[^"]+", not "/i.test(
      message,
    )
  ) {
    return "name_conflict";
  }
  // Something of the app deleted outside Appflare, found before the job
  // changes anything (a pause's or resume's Worker, an update's stream).
  if (/ is gone from the account\b/.test(message)) return "preflight";
  if (/^The Cloudflare Access application ".*" already covers /.test(message)) {
    return "access_conflict";
  }
  // Refusals Appflare words itself, without Cloudflare's status: the token
  // (or the Cloudflare sign-in) lacks a permission.
  if (
    /^The Cloudflare token cannot (manage|read) |^Cloudflare did not let Appflare\b[^.]*\bCloudflare sign-in\b|^Cloudflare refused the (Pipelines|R2 Data Catalog|Hyperdrive) call\b|^Cloudflare could not create the sink of |^Cloudflare refused to attach \S+: the token needs |[Tt]he Cloudflare token (lacks |cannot see that (zone|domain))|or the token lacks |^Appflare's API token (lacks|cannot use) /.test(
      message,
    )
  ) {
    return "cloudflare_permission";
  }
  if (
    /^This Cloudflare account has no Zero Trust organization|^This account has no workers\.dev subdomain|^The Zero Trust organization's team domain /.test(
      message,
    )
  ) {
    return "preflight";
  }
  if (
    /signature|digest [0-9a-f]+ does not match|sha256 [0-9a-f]+ does not match|not a valid artifact manifest|^the artifact is (for|version|format \d+|"[^"]*", not)|got \d+ bytes, expected|manifest\.json (is not valid JSON|has no keyId|is signed with|changed since)|^artifact is unsigned|no trusted signing key matches keyId|is not valid base64|^the (catalog manifest|built manifest\.json|build is (for|version|from|stored)|build's (zip|manifest\.json))\b|does not carry (a sandbox tier|the catalog manifest)|^the release (declares|has no)\b|not a sandbox Worker release|^the recorded artifact manifest (does not match|changed)|^This catalog's index is not signed/i.test(
      message,
    )
  ) {
    return "artifact_integrity";
  }
  if (
    /^GET \S+ (-> \d{3}|failed)|^GitHub (did not answer with|has no sandbox Worker release)|^the release \S+ (is not published|has no |has unusable)|^GET \S+: (more than \d+ redirects|redirected to a URL that is not HTTPS)/.test(
      message,
    )
  ) {
    return "artifact_fetch";
  }
  // The Workflows engine's own limits (workers-sdk workflows-shared
  // context.ts): before "terminated", which some of them also say.
  if (WORKFLOW_LIMIT.test(message)) return "workflow_limit";
  if (/terminated|cancell?ed/i.test(message)) return "cancelled";
  if (/timed? ?out/i.test(message)) return "timeout";
  for (const [pattern, category] of MESSAGE_CATEGORIES) {
    if (pattern.test(message)) return category;
  }
  if (cfStatus === 401 || cfStatus === 403) return "cloudflare_permission";
  if (cfStatus === 429) return "cloudflare_rate_limited";
  if (cfStatus !== null && cfStatus >= 500) return "cloudflare_unavailable";
  if (cfStatus !== null && cfStatus >= 400) return "cloudflare_rejected";
  return null;
}

/** What the Workflows engine says when a job passes one of its limits. */
const WORKFLOW_LIMIT =
  /exceeds max length \(\d+ chars\)|The limit of \d+ steps has been reached|output is too large\. Maximum allowed size|exceeded the \d+\s?[GM]iB storage limit|is not serialisable/;

/**
 * Last, when neither the message nor the phase says more: the manager's own
 * database refusing (an app's D1 migration is `d1_migration` by its phase
 * before this), and a job whose Workflow instance ended without recording
 * the end of the job, or never started (jobs/reconcile.server.ts).
 */
function fallbackCategory(text: string, message: string): ErrorCategory | null {
  if (/\bD1_[A-Z_]+\b|\bSQLITE_[A-Z_]+\b/.test(message)) return "manager_database";
  if (/^the job's Workflow instance (failed|no longer exists)/.test(text)) return "job_stopped";
  if (/^Cloudflare never started the job's Workflow instance/.test(text)) return "job_stopped";
  return null;
}

/**
 * Which preflight check refused, from its message; first match wins. A
 * refusal of Cloudflare's own with no words of Appflare's falls back to its
 * status ({@link preflightReason}).
 */
const PREFLIGHT_REASON_PATTERNS: readonly [RegExp, PreflightReason][] = [
  [
    /needs Workers Paid; confirm|^Sandbox builds need Workers Paid|runs on a schedule, which needs the Workers Paid plan/,
    "plan_paid_required",
  ],
  [/on Workers Paid; confirm (the build's|its) cost/, "cost_unconfirmed"],
  [/; confirm the account meets these requirements/, "requirements_unconfirmed"],
  [
    /^the API token is (?!active)|^Cloudflare refused the Pipelines call|[Tt]he Cloudflare token (lacks|cannot (manage|read))|^Appflare's API token (lacks|cannot use)|^Cloudflare did not let Appflare/,
    "token_permission_missing",
  ],
  [
    /^the Cloudflare API token is not configured|^Cloudflare no longer accepts Appflare's connection|cannot read its saved connection to Cloudflare|still redeploying itself with its new Cloudflare connection|could not renew its access to Cloudflare|renewing its access to Cloudflare in another request|^Cloudflare refused to renew Appflare's access/,
    "connection_needed",
  ],
  [
    /^the Cloudflare account is not known yet|^Appflare does not know its (own Worker|Cloudflare account and Worker) yet/,
    "account_unknown",
  ],
  // Before the account's other limits: Workers Free's cron trigger limit
  // is worded "allows 5 per account" too.
  [
    /needs .{1,40} cron triggers? and the account's other Workers already use|cron triggers per account/,
    "cron_limit",
  ],
  [/allows [\d,]+ (Workers )?per account/, "account_limit"],
  [
    /one job for them would (run|make) an estimated|but Appflare uploads at most|subrequests to read its \d+ Worker modules/,
    "job_too_big",
  ],
  [
    /already exists in this account|already uses the Worker name "|is already installed as "|only works as the Worker "|^the install was claimed as "|serves the app from "[^"]+", not "/,
    "name_taken",
  ],
  [/^R2 is not enabled on this/, "r2_not_enabled"],
  [
    /^This Cloudflare account has no Zero Trust organization|^The Zero Trust organization's team domain /,
    "zero_trust_missing",
  ],
  [/^This account has no workers\.dev subdomain/, "workers_dev_missing"],
  [
    /is not active on Cloudflare yet|does not use Cloudflare DNS|belongs to another Cloudflare account|receives its mail elsewhere|routing rules; \d+ more would pass/,
    "email_zone_unusable",
  ],
  [
    /Appflare is not connected to (it|one|a sandbox Worker|the sandbox Worker)|^the sandbox Worker \S+ (cannot |speaks protocol )|^sandbox builds (could not be turned on|are still being turned on)|^Sandbox builds are in use by/,
    "sandbox_required",
  ],
  [
    /is not the catalog's current version|^version \S+ is already installed|is older than the installed version|^Appflare \S+ is running, not |^the catalog now lists |^the artifact is format \d+/,
    "release_mismatch",
  ],
  [/^the catalog "[^"]+" this app comes from was removed/, "catalog_removed"],
  [
    /signature|digest [0-9a-f]+ does not match|sha256 [0-9a-f]+ does not match|not a valid artifact manifest|manifest\.json (is not valid JSON|has no keyId|is signed with|changed since)|^artifact is unsigned|no trusted signing key matches keyId|is not valid base64|^the artifact is (for|version|"[^"]*", not)|^the (catalog manifest|release (declares|has no))\b|not a sandbox Worker release|^the recorded artifact manifest (does not match|changed)|^This catalog's index is not signed/i,
    "manifest_invalid",
  ],
  [
    /^GET \S+ (-> \d{3}|failed)|^GitHub (did not answer with|has no sandbox Worker release)/,
    "artifact_unavailable",
  ],
  [
    /cannot install \S+ tier apps yet|which Appflare cannot install yet|self-contained apps only|defines no Workflow of that name|would share its name with a binding's resource|cannot be reshaped in place|Cloudflare cannot change a stream|does not replace a resource on update|an update cannot create|no longer declares the Durable Object|must (be protected|run behind) .*Cloudflare Access|^the artifact has no primary Worker/,
    "app_unsupported",
  ],
  [
    / is required\.|: The connection string |^This is not a connection string|is not a database connection of this app|^[Nn]o value was provided for |started without its connection string|deploys with its own Cloudflare token; enter it|characters; choose a shorter Worker name|starts with a letter\.$|choose a zone for it/,
    "input_missing",
  ],
  [
    /^the install (no longer exists|is \w+, not |is not uninstalled|was not deployed by|never got as far|is being removed)|^only an installed app can be|^the app is (not|already) paused|^another pause of the app|^the app's pause closed|^the snapshot does not belong|^a catalog install cannot be replaced/,
    "install_state",
  ],
  [/a gradual deployment is in progress/, "deployment_in_progress"],
  [/ is gone from the account\b| is gone at Cloudflare|has since been deleted/, "deleted_outside"],
  [
    /was uploaded after this job's version|serves a stand-in of an earlier pause|has no deployment, so there is nothing to pause|lacks Durable Object migrations up to/,
    "changed_outside",
  ],
];

/**
 * The checks that count what the account already has, by their step: the
 * cron trigger count (`check cron trigger limit`), and the D1, Hyperdrive and
 * Vectorize counts (`check D1 database limit`, jobs/install/account-limits.ts).
 */
const LIMIT_STEP_REASONS: readonly [RegExp, PreflightReason][] = [
  [/^check cron trigger limit$/, "cron_limit"],
  [/^check [A-Za-z0-9 ]+ limit$/, "account_limit"],
];

/**
 * Which preflight check refused: a count's by its step when it refused for
 * the limit (not when its read failed), else from its message, else
 * Cloudflare's status, else `preflight_other`.
 */
function preflightReason(
  step: string,
  message: string,
  cfStatus: number | null,
  errorCategory: ErrorCategory,
): PreflightReason {
  if (errorCategory === "plan_limit") {
    for (const [pattern, reason] of LIMIT_STEP_REASONS) {
      if (pattern.test(step)) return reason;
    }
  }
  for (const [pattern, reason] of PREFLIGHT_REASON_PATTERNS) {
    if (pattern.test(message)) return reason;
  }
  if (cfStatus === 401 || cfStatus === 403) return "token_permission_missing";
  if (cfStatus !== null && (cfStatus === 429 || cfStatus >= 500)) return "cloudflare_unavailable";
  if (cfStatus !== null && cfStatus >= 400) return "cloudflare_rejected";
  return "preflight_other";
}

/**
 * A move of Appflare's address whose new address never answered as this
 * Appflare (`MOVE_FAILURES.neverAnswered`, domains/move-address-lines.ts):
 * its text has no step before it, and carries the last answer.
 */
const NEVER_ANSWERED =
  /^\S+ never answered as this Appflare within \d+ minutes \(last answer: ([\s\S]*?)\), so Appflare stays at its current address\./;

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
  const never = NEVER_ANSWERED.exec(text);
  if (never !== null) {
    return {
      errorCategory: "address_not_serving",
      failedPhase: "address",
      failureReason: addressAnswerOf(never[1] ?? ""),
      cfStatus: null,
      cfCode: null,
      cfMessage: null,
    };
  }
  const { step, message } = splitJobError(text);
  const cf = CLOUDFLARE_FAILURE.exec(text);
  const cfStatus = cf?.[1] === undefined ? null : Number(cf[1]);
  const cfCode = cf?.[2] === undefined ? null : Number(cf[2]);
  const phase = failedPhase(step);
  const errorCategory =
    categoryFromMessage(message, cfStatus, cfCode) ??
    CATEGORY_BY_PHASE[phase] ??
    fallbackCategory(text, message) ??
    "unknown";
  const failureReason =
    phase === "preflight" || errorCategory === "preflight"
      ? preflightReason(failedStepName(step), message, cfStatus, errorCategory)
      : null;
  const cfMessage =
    cf !== null && names !== null && errorCategory.startsWith("cloudflare_")
      ? cloudflareMessage(cloudflareDetail(text, cf), names)
      : null;
  return { errorCategory, failedPhase: phase, failureReason, cfStatus, cfCode, cfMessage };
}
