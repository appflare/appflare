import { CUSTOM_DOMAIN_KIND, CUSTOM_HOSTNAME_KIND } from "./resource-kinds";
import { workersDevBase } from "./workers-dev";

/**
 * An install's primary address: the URL its "Open" button opens, on the
 * home list, the app page and job pages. Client-safe (no bindings).
 *
 * Health checks and version checks do not use it: they go through the
 * workers.dev URL while that is on (see `appBaseUrl`), since a domain may
 * still be waiting for its certificate.
 */

/** A custom domain (`domain`) or external domain (`custom_hostname`) of the install. */
export interface AddressDomain {
  /** `resources.id`; it ends with a ULID, so ids sort by when the domain was added. */
  id: string;
  kind: string;
  /** The hostname. */
  name: string;
  /** A request through it has reached the app (`resources.live_at` is set). */
  live: boolean;
}

export interface AppAddressInput {
  workerName: string;
  workersDevEnabled: boolean;
  /** `installs.served_domain`. */
  servedDomain: string | null;
  /** The install's domains that are not deleted, in any order. */
  domains: readonly AddressDomain[];
  /** The account's workers.dev subdomain; null when unknown. */
  subdomain: string | null | undefined;
}

function byId(a: AddressDomain, b: AddressDomain): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Where the app is opened: the domain that answered when workers.dev was
 * turned off (while it is still attached), else the first live custom
 * domain, else the first live external domain, else the workers.dev URL
 * while that is on. Null when none of these is there (workers.dev off and
 * no live domain, or the subdomain unknown).
 */
export function appAddress(install: AppAddressInput): string | null {
  const { servedDomain, domains } = install;
  if (servedDomain !== null && domains.some((d) => d.name === servedDomain)) {
    return `https://${servedDomain}`;
  }
  const live = domains.filter((d) => d.live).sort(byId);
  const domain =
    live.find((d) => d.kind === CUSTOM_DOMAIN_KIND) ??
    live.find((d) => d.kind === CUSTOM_HOSTNAME_KIND);
  if (domain !== undefined) return `https://${domain.name}`;
  if (install.workersDevEnabled && install.subdomain) {
    return workersDevBase(install.workerName, install.subdomain);
  }
  return null;
}
