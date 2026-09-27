// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
// CF_API_TOKEN only exists after setup, so it is optional; so is
// BETTER_AUTH_SECRET (below). Declared on both
// `Cloudflare.Env` (the type of `import { env } from "cloudflare:workers"`)
// and the global `Env`.
interface ManagerSecrets {
  /**
   * Set by the installer; a manager deployed from the "Deploy to Cloudflare"
   * button has none until setup's first step writes one.
   */
  BETTER_AUTH_SECRET?: string;
  /**
   * Set by installers from before setup started with the API token. It
   * guards nothing now; the first token save deletes it.
   */
  SETUP_TOKEN?: string;
  CF_API_TOKEN?: string;
  /**
   * Optional GitHub token that can read appflare/appflare's releases. Needed
   * only while that repository is private; sent only to api.github.com and
   * github.com, never logged.
   */
  GITHUB_TOKEN?: string;
  /**
   * `v1.<expires at, epoch ms>.<sha-256 hex>` of a one-time recovery code,
   * written by `create-appflare recover` (see @appflare/schema's
   * recovery-code.ts). Deleted by the manager once used.
   */
  RECOVERY_CODE_HASH?: string;
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
  /**
   * Service binding to the sandbox Worker (`appflare-sandbox`, entrypoint
   * `SandboxBuilds`). Not in wrangler.jsonc: the sandbox Worker is optional
   * and may not exist when the manager is deployed, so the manager adds the
   * binding to itself once it does (from Settings, or at its next
   * self-update). Read it through `sandboxBinding()`.
   */
  SANDBOX?: unknown;
  /**
   * `off` (or `0`, `false`) turns anonymous usage data off on this Worker,
   * whatever Settings says. The CLI sets it for `--no-telemetry`.
   */
  APPFLARE_TELEMETRY?: string;
  /** `1` turns anonymous usage data off, like `APPFLARE_TELEMETRY=off`. */
  DO_NOT_TRACK?: string;
  /** The random install id the CLI used for its own usage data; the manager continues it. */
  APPFLARE_INSTALL_ID?: string;
  /**
   * How this manager was first deployed. `deploy-button` on managers the
   * "Deploy to Cloudflare" button deployed (the deploy repository's
   * wrangler.jsonc sets it); unset otherwise. Read it through
   * `deployButtonInstalled()`.
   */
  APPFLARE_INSTALL_SOURCE?: string;
  /**
   * `send_email` binding for password reset emails. Not in wrangler.jsonc:
   * the owner turns reset emails on from Settings > Users, and the manager
   * adds the binding to itself then (auth/password-email.server.ts).
   */
  AUTH_EMAIL?: SendEmail;
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
