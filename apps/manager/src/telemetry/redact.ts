/**
 * Removes private values from text an admin is about to send to the Appflare
 * team in a failure report: tokens, keys and passwords, email addresses,
 * Cloudflare account ids and other ids, and this account's own names (its
 * workers.dev subdomain, its hostnames and its Worker names).
 *
 * Job log lines are written without secret values (steps log names, never
 * values, and Cloudflare API calls as `METHOD path -> status` only), but
 * they carry account ids in API paths, and an upstream build's output or a
 * Cloudflare error message can echo anything. So every text of a report goes
 * through here once more, just before it leaves, whatever was done when it
 * was written. Pattern based and deliberately eager: a false positive only
 * hides a harmless value from the report. What stays readable: error codes,
 * statuses, step names, versions and the app's catalog slug.
 */

export const REDACTED = "[redacted]";
export const REDACTED_EMAIL = "[email]";
export const REDACTED_ACCOUNT = "[account id]";
export const REDACTED_ID = "[id]";
export const REDACTED_DOMAIN = "[domain]";
export const REDACTED_WORKER = "[worker]";

/** This account's own names, taken out of a report wherever they appear. */
export interface AccountNames {
  /** The account's workers.dev subdomain (`<subdomain>.workers.dev`). */
  subdomain: string | null;
  /** Custom and external hostnames, routes' hosts, DNS record names. */
  hostnames: readonly string[];
  /** Every Worker name: the manager's, the apps', and their other Workers. */
  workers: readonly string[];
}

export const NO_ACCOUNT_NAMES: AccountNames = { subdomain: null, hostnames: [], workers: [] };

/**
 * Words that name a secret when a value follows them (`token=…`,
 * `"password": "…"`, `--password …`). `key` counts only as a whole word or
 * the last part of a name (`key`, `STRIPE_KEY`, `api-key`), never inside
 * one (`monkey`, `keyboard`).
 */
const SECRET_WORDS =
  "(?:access[_-]?key|api[_-]?key|api[_-]?token|apikey|auth(?:orization)?|bearer|client[_-]?secret|credentials?|pass(?:word|wd|phrase)?|private[_-]?key|pwd|secret(?:[_-]?key)?|session|signing[_-]?key|token)";
const SECRET_NAME_BODY = `(?:[A-Za-z0-9_-]*${SECRET_WORDS}[A-Za-z0-9_-]*|(?:[A-Za-z0-9]+[_-])*key)`;
/** A secret's name, not the tail of a longer name. */
const SECRET_NAME = `(?<![A-Za-z0-9_-])${SECRET_NAME_BODY}`;

/** Keeps the name and the value's quotes; replaces the value. */
function keepQuotes(match: string, name: string, value: string): string {
  // Already replaced by an earlier rule (`--api-key=[redacted]`).
  if (value.startsWith("[redacted")) return match;
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
  return `${name}${quote}${REDACTED}${quote}`;
}

type Rule = [RegExp, string | ((match: string, ...groups: string[]) => string)];

const RULES: readonly Rule[] = [
  // PEM blocks (private keys, certificates).
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, REDACTED],
  // Environment lines (`NAME=value`, `export NAME=value`): every value, whatever the name.
  [/^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*=).+$/gm, `$1${REDACTED}`],
  // Credentials inside a URL: scheme://user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Webhook addresses carry their secret in the path.
  [/https:\/\/hooks\.slack\.com\/[^\s"'<>]+/gi, `https://hooks.slack.com/${REDACTED}`],
  [
    /https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/gi,
    `https://discord.com/api/webhooks/${REDACTED}`,
  ],
  [/(api\.telegram\.org\/bot)[^\s/"'<>]+/gi, `$1${REDACTED}`],
  // Authorization headers.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  // JSON web tokens.
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, REDACTED],
  // Tokens with a well-known prefix (GitHub, Slack, PostHog personal keys, OpenAI-style keys).
  [
    /\b(?:gh[pousr]_|github_pat_|xox[abposr]-|phx_|sk-|sk_live_|rk_live_)[A-Za-z0-9_-]{10,}/g,
    REDACTED,
  ],
  // Telegram bot tokens.
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, REDACTED],
  // Command-line flags that name a secret: `--password hunter2`, `--api-key=…`.
  [
    new RegExp(
      `((?<![A-Za-z0-9_-])--${SECRET_NAME_BODY}(?:\\s+|=))("[^"]*"|'[^']*'|[^\\s"']+)`,
      "gi",
    ),
    keepQuotes,
  ],
  // `name=value` and `"name": "value"` where the name says it is a secret. An
  // unquoted `name: value` is left to the rules around it: job errors read
  // `<step>: <message>`, and a step may well be called "verify token".
  [new RegExp(`(${SECRET_NAME}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s,;&"'}\\]]+)`, "gi"), keepQuotes],
  [
    new RegExp(`(["']${SECRET_NAME}["']\\s*:\\s*)("[^"]*"|'[^']*'|[^\\s,;}\\]]+)`, "gi"),
    keepQuotes,
  ],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, REDACTED_EMAIL],
  // The account id in Cloudflare API paths and dashboard addresses.
  [/(\/accounts\/|dash\.cloudflare\.com\/(?:\?to=\/)?)[0-9a-f]{32}\b/gi, `$1${REDACTED_ACCOUNT}`],
  // UUIDs: D1 databases, Workers versions, deployments.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, REDACTED_ID],
  // Any other 32-character (or longer) hex value: zone, namespace and account ids, hex secrets.
  [/\b[0-9a-f]{32,}\b/gi, REDACTED_ID],
  // Long random-looking values (API tokens, base64 keys): from 32 characters,
  // any mix of letters and digits; shorter ones only with both cases and a digit.
  [
    /[A-Za-z0-9_+/=-]{24,}/g,
    (match: string) => {
      const letter = /[A-Za-z]/.test(match);
      const digit = /\d/.test(match);
      if (match.length >= 32) return letter && digit ? REDACTED : match;
      return /[A-Z]/.test(match) && /[a-z]/.test(match) && digit ? REDACTED : match;
    },
  ],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A name matched whole: not inside a longer name or hostname label. */
function wholeName(names: readonly string[], flags: string): RegExp | null {
  const usable = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  if (usable.length === 0) return null;
  return new RegExp(
    `(?<![A-Za-z0-9_-])(?:${usable.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-])`,
    flags,
  );
}

/** The rules that take this account's own names out, hostnames first (they contain Worker names). */
function accountRules(names: AccountNames): Rule[] {
  const rules: Rule[] = [];
  const hosts = wholeName(
    names.hostnames.map((h) => h.replace(/^\*\./, "").replace(/\/.*$/, "")),
    "gi",
  );
  if (hosts !== null) rules.push([hosts, REDACTED_DOMAIN]);
  if (names.subdomain !== null && names.subdomain.length > 0) {
    const sub = escapeRegExp(names.subdomain);
    rules.push([
      new RegExp(`(?<![A-Za-z0-9-])${sub}(?=\\.workers\\.dev\\b)`, "gi"),
      REDACTED_DOMAIN,
    ]);
    const bare = wholeName([names.subdomain], "gi");
    if (bare !== null) rules.push([bare, REDACTED_DOMAIN]);
  }
  const workers = wholeName(names.workers, "gi");
  if (workers !== null) rules.push([workers, REDACTED_WORKER]);
  return rules;
}

/** `text` with every private-looking value, and this account's own names, replaced by a marker. */
export function redactReportText(text: string, names: AccountNames = NO_ACCOUNT_NAMES): string {
  let out = text;
  for (const [pattern, replacement] of [...RULES, ...accountRules(names)]) {
    out =
      typeof replacement === "string"
        ? out.replace(pattern, replacement)
        : out.replace(pattern, replacement as (substring: string, ...args: string[]) => string);
  }
  return out;
}
