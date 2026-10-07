import { parsePublicKeys, type SigningKey } from "@appflare/schema";
import { parseVersion } from "./versions";

/**
 * The installer's configuration, read from its vars on every request and
 * refused whole when anything is off, so a misconfigured deploy answers
 * "not available" instead of deploying from the wrong place.
 *
 * Development release override (`DEV_RELEASE_URL` + `DEV_RELEASE_KEYS`): lets
 * the dev deployment install a test release signed with a dev key before a
 * real release exists. It cannot reach production by accident:
 *
 * - `INSTALLER_ENV` must be set, to `production` or `development`; no default.
 * - With `production`, either dev variable being set at all is a
 *   configuration error: every request is refused, nothing is deployed.
 * - wrangler does not inherit `vars` into environments, so the top-level
 *   (development) vars never reach `env.production`.
 * - Dev keys must have ids starting with `dev-`, they verify only releases
 *   read from `DEV_RELEASE_URL`, and GitHub releases verify only against the
 *   embedded Appflare keys (`appflare-*` ids). A dev-signed release can never
 *   pass the production check, and a real release never needs a dev key.
 */

export type InstallerEnvironment = "production" | "development";

export interface DevRelease {
  /** Base URL, no trailing slash: `<url>/manifest.json`, `<url>/manifest.sig`, `<url>/appflare-<version>.zip`. */
  url: string;
  keys: SigningKey[];
}

export interface InstallerConfig {
  environment: InstallerEnvironment;
  /** `https://appflare.dev`: no path, no trailing slash. */
  origin: string;
  minManagerVersion: string;
  devRelease: DevRelease | null;
}

export const DEV_KEY_PREFIX = "dev-";

/** Lists the variables at fault by name only; values are never logged or shown. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t.length === 0 ? undefined : t;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function readConfig(env: Env): InstallerConfig {
  const problems: string[] = [];
  const environment = trimmed(env.INSTALLER_ENV);
  if (environment !== "production" && environment !== "development") {
    problems.push("INSTALLER_ENV must be production or development");
  }
  const production = environment === "production";

  let origin = "";
  const rawOrigin = trimmed(env.INSTALLER_ORIGIN);
  try {
    const url = new URL(rawOrigin ?? "");
    const allowed =
      url.protocol === "https:" ||
      (!production && url.protocol === "http:" && isLocalHost(url.hostname));
    if (!allowed || url.origin !== rawOrigin?.replace(/\/$/, "")) throw new Error();
    origin = url.origin;
  } catch {
    problems.push("INSTALLER_ORIGIN must be an https origin without a path");
  }

  const minManagerVersion = trimmed(env.MIN_MANAGER_VERSION) ?? "";
  if (parseVersion(minManagerVersion) === null) {
    problems.push("MIN_MANAGER_VERSION must be a version such as 0.4.0");
  }

  const devUrl = trimmed(env.DEV_RELEASE_URL);
  const devKeys = trimmed(env.DEV_RELEASE_KEYS);
  let devRelease: DevRelease | null = null;
  if (production) {
    if (devUrl !== undefined) problems.push("DEV_RELEASE_URL must not be set in production");
    if (devKeys !== undefined) problems.push("DEV_RELEASE_KEYS must not be set in production");
  } else if (devUrl !== undefined || devKeys !== undefined) {
    if (devUrl === undefined || devKeys === undefined) {
      problems.push("DEV_RELEASE_URL and DEV_RELEASE_KEYS go together");
    } else {
      let url: URL | null = null;
      try {
        url = new URL(devUrl);
      } catch {
        // reported below
      }
      if (url === null || url.protocol !== "https:" || url.search !== "" || url.hash !== "") {
        problems.push("DEV_RELEASE_URL must be an https URL without a query");
      }
      let keys: SigningKey[] = [];
      try {
        keys = parsePublicKeys(devKeys);
      } catch {
        problems.push("DEV_RELEASE_KEYS must be public keys as the packer prints them");
      }
      if (keys.some((k) => !k.keyId.startsWith(DEV_KEY_PREFIX))) {
        problems.push(`DEV_RELEASE_KEYS key ids must start with ${DEV_KEY_PREFIX}`);
      }
      if (url !== null && keys.length > 0) {
        devRelease = { url: devUrl.replace(/\/+$/, ""), keys };
      }
    }
  }

  if (problems.length > 0) throw new ConfigError(problems.join("; "));
  return {
    environment: environment as InstallerEnvironment,
    origin,
    minManagerVersion,
    devRelease,
  };
}
