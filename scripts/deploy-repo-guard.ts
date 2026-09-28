import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseJsonc } from "@appflare/pack";

/**
 * A last check on the public deploy repository before it leaves the machine
 * that built it: no file in it may contain an account id pinned in this
 * repository's wrangler configs, or a credential from a local `.env`. The
 * release's own files are signed and hash-checked, so a hit means a build
 * picked up a local value, and the copy is refused rather than published.
 */

/** A value that must not appear in the deploy repository. */
export interface Secret {
  /** Where the value comes from. Safe to print; the value never is. */
  source: string;
  value: string;
}

/** A Cloudflare account id: 32 hexadecimal characters. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

/**
 * `.env` values shorter than this are not searched for: a short value (`1`,
 * `true`, a region name) would match unrelated text, while the credentials a
 * `.env` holds here (an API token, an account id) are far longer.
 */
export const MIN_ENV_VALUE_LENGTH = 16;

/** `KEY=VALUE` lines as dotenv reads them: blanks and `#` comments skipped, quotes and `export` stripped. */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Every `account_id` a wrangler config pins, at the top level or in an environment. */
function accountIds(config: unknown): string[] {
  if (typeof config !== "object" || config === null) return [];
  const record = config as { account_id?: unknown; env?: unknown };
  const ids = typeof record.account_id === "string" ? [record.account_id] : [];
  if (typeof record.env === "object" && record.env !== null) {
    for (const env of Object.values(record.env)) ids.push(...accountIds(env));
  }
  return ids.filter((id) => ACCOUNT_ID.test(id));
}

/**
 * The values the deploy repository must not contain: the `account_id` of
 * every wrangler config tracked in `repoRoot`, and every value in
 * `repoRoot/.env` (when there is one) of at least `MIN_ENV_VALUE_LENGTH`.
 * Throws when git cannot list the tracked configs, since an empty list would
 * let the check pass without checking anything.
 */
export function repoSecrets(repoRoot: string): Secret[] {
  const res = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--", ":(glob)**/wrangler.json", ":(glob)**/wrangler.jsonc"],
    { encoding: "utf8" },
  );
  if (res.error || res.status !== 0) {
    throw new Error(
      `could not list the wrangler configs in ${repoRoot}: ${res.error?.message ?? res.stderr.trim()}`,
    );
  }
  const secrets: Secret[] = [];
  const add = (source: string, value: string): void => {
    if (!secrets.some((s) => s.value.toLowerCase() === value.toLowerCase())) {
      secrets.push({ source, value });
    }
  };
  for (const file of res.stdout.split("\0").filter((name) => name.length > 0)) {
    const config = parseJsonc(readFileSync(path.join(repoRoot, file), "utf8"));
    for (const id of accountIds(config)) add(`the account_id in ${file}`, id);
  }
  const envPath = path.join(repoRoot, ".env");
  if (existsSync(envPath)) {
    for (const [name, value] of Object.entries(parseDotenv(readFileSync(envPath, "utf8")))) {
      if (value.length >= MIN_ENV_VALUE_LENGTH) add(`the value of ${name} in .env`, value);
    }
  }
  return secrets;
}

function* walkFiles(dir: string, rel = ""): Generator<string> {
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) yield* walkFiles(dir, child);
    else if (entry.isFile()) yield child;
  }
}

/**
 * Which files under `dir` contain which secret, as `<file> contains <source>`
 * (empty = none). Account ids match in either case. Never includes a value.
 */
export function findSecrets(dir: string, secrets: readonly Secret[]): string[] {
  const needles = secrets.map((secret) => ({
    source: secret.source,
    forms: [
      ...new Set(
        ACCOUNT_ID.test(secret.value)
          ? [secret.value.toLowerCase(), secret.value.toUpperCase()]
          : [secret.value],
      ),
    ].map((form) => Buffer.from(form, "utf8")),
  }));
  const found: string[] = [];
  for (const file of walkFiles(dir)) {
    const bytes = readFileSync(path.join(dir, file));
    for (const needle of needles) {
      if (needle.forms.some((form) => bytes.includes(form))) {
        found.push(`${file} contains ${needle.source}`);
      }
    }
  }
  return found;
}
