/**
 * Builds the environment for every child process the packer spawns (`pnpm
 * install`, `wrangler deploy --dry-run` and the checkout's own `build.command` it
 * runs, `git`). Those children execute third-party code from the pinned checkout,
 * so no credential the packer holds may reach them.
 *
 * Removed:
 * - `CLOUDFLARE_*`, `WRANGLER_*`: nothing may reach any Cloudflare account.
 * - every name in `extraNames` (the packer passes the `--sign-key-env` variable).
 * - any name ending in `_SIGNING_KEY` or `SIGN_KEY` (defensive: other signing keys).
 * - `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN` (CI credentials).
 * Matching is case-insensitive.
 */
const SCRUB_PATTERNS: readonly RegExp[] = [
  /^CLOUDFLARE_/i,
  /^WRANGLER_/i,
  /_SIGNING_KEY$/i,
  /SIGN_KEY$/i,
  /^(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN)$/i,
];

export function scrubEnv(
  base: NodeJS.ProcessEnv,
  extraNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const extra = new Set(extraNames.map((n) => n.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) {
      continue;
    }
    if (extra.has(key.toUpperCase()) || SCRUB_PATTERNS.some((re) => re.test(key))) {
      continue;
    }
    out[key] = value;
  }
  // Added after scrubbing: suppress wrangler's telemetry (an outbound call) and
  // keep the dry-run non-interactive.
  out.WRANGLER_SEND_METRICS = "false";
  out.CI = base.CI ?? "1";
  // Let the machine's pnpm run in a checkout that pins a different pnpm major
  // (e.g. Cut pins pnpm 11) without fetching a new pnpm. This covers our own
  // install step and any pnpm the checkout's `build.command` spawns.
  out.COREPACK_ENABLE_STRICT = "0";
  out.npm_config_package_manager_strict = "false";
  return out;
}
