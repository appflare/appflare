/**
 * The bindings of wrangler.jsonc. Configuration is read and checked once per
 * request by config.ts; nothing else reads these directly.
 */
interface Env {
  /** Installation records. */
  DB: D1Database;
  /** `production` or `development`; anything else is refused. */
  INSTALLER_ENV?: string;
  /** The origin of the deploy page and this API, e.g. `https://appflare.dev`. */
  INSTALLER_ORIGIN?: string;
  /** The oldest Appflare release the installer deploys, e.g. `0.4.0`. */
  MIN_MANAGER_VERSION?: string;
  /**
   * Development only: where a test release lives (`<url>/manifest.json`,
   * `<url>/manifest.sig`, `<url>/appflare-<version>.zip`) instead of GitHub.
   */
  DEV_RELEASE_URL?: string;
  /** Development only: the public key(s) that sign the test release, key ids `dev-*`. */
  DEV_RELEASE_KEYS?: string;
}

declare namespace Cloudflare {
  interface Env extends globalThis.Env {}
}
