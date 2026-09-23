// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
// SETUP_TOKEN is deleted after setup and CF_API_TOKEN only exists after it,
// so both are optional. Declared on both `Cloudflare.Env` (the type of
// `import { env } from "cloudflare:workers"`) and the global `Env`.
interface ManagerSecrets {
  BETTER_AUTH_SECRET: string;
  SETUP_TOKEN?: string;
  CF_API_TOKEN?: string;
  /**
   * Optional GitHub token that can read appflare/appflare's releases. Needed
   * only while that repository is private; sent only to api.github.com and
   * github.com, never logged.
   */
  GITHUB_TOKEN?: string;
}

// Optional vars that are not in wrangler.jsonc (code defaults apply when unset):
// local overrides go in apps/manager/.dev.vars.
interface ManagerOptionalVars {
  /** Catalog `index.json` URL; defaults to `DEFAULT_CATALOG_INDEX_URL`. */
  CATALOG_INDEX_URL?: string;
  /** Cloudflare API base override for tests and local dev against a fake API. */
  CF_API_BASE_URL?: string;
  /** The manager's releases API; defaults to `DEFAULT_MANAGER_RELEASES_URL`. */
  MANAGER_RELEASES_URL?: string;
}

declare namespace Cloudflare {
  interface Env extends ManagerSecrets, ManagerOptionalVars {}
}

interface Env extends ManagerSecrets, ManagerOptionalVars {}

// Workers' non-standard constant-time compare. The DOM lib (needed by the React
// code in the same program) owns the global `crypto` type and lacks it.
interface SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}
