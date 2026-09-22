import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";

/**
 * `@appflare/cf-api/dev`: a Node-only entry for scripts and tests. Kept out of the
 * main entry so nothing here (`node:fs`, `node:path`, `process`) is bundled into a
 * Worker. Reads the dev-account credentials from the repo-root `.env` ONLY — never
 * from ambient `process.env` — so a token exported in the shell can never
 * point dev tooling at another account.
 */

export interface DevContext {
  accountId: string;
  token: string;
}

const TOKEN_VAR = "CLOUDFLARE_API_TOKEN";
const ACCOUNT_VAR = "CLOUDFLARE_ACCOUNT_ID";

const envSchema = z.object({
  [ACCOUNT_VAR]: z.string().min(1),
  [TOKEN_VAR]: z.string().min(1),
});

/**
 * Loads `{ accountId, token }` from the repo-root `.env`. Throws a clear error
 * naming (never printing) any missing/empty variable, or when the repo root or
 * `.env` cannot be found.
 */
export function loadDevContext(): DevContext {
  const root = findRepoRoot(process.cwd());
  if (root === null) {
    throw new Error(
      "loadDevContext: could not locate the repo root (no pnpm-workspace.yaml above the current directory)",
    );
  }

  const envPath = join(root, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`loadDevContext: ${envPath} does not exist`);
  }

  const parsed = envSchema.safeParse(parseEnvFile(readFileSync(envPath, "utf8")));
  if (!parsed.success) {
    // Report variable NAMES only, never their values.
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`loadDevContext: missing or empty ${names.join(", ")} in ${envPath}`);
  }

  return {
    accountId: parsed.data[ACCOUNT_VAR],
    token: parsed.data[TOKEN_VAR],
  };
}

/**
 * True when {@link loadDevContext} would succeed. Use it to skip integration
 * tests when the dev `.env` is absent, e.g. `describe.skipIf(!hasDevContext())`.
 */
export function hasDevContext(): boolean {
  try {
    loadDevContext();
    return true;
  } catch {
    return false;
  }
}

/** Walks up from `start` to the directory holding `pnpm-workspace.yaml`. */
function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Minimal `KEY=VALUE` parser: ignores blanks/`#` comments, strips quotes/`export`. */
function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith("export ")) {
      key = key.slice("export ".length).trim();
    }
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
