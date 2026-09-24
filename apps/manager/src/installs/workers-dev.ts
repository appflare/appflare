import { z } from "zod";

/**
 * An install's workers.dev URL (`<worker>.<subdomain>.workers.dev`): on by
 * default, and switchable off on the app page ("Serve on workers.dev") while
 * a custom domain serves the app. Client-safe (no bindings).
 *
 * Every call that deploys an app's Worker also sends
 * `POST /workers/scripts/{name}/subdomain`, and Cloudflare applies exactly
 * what it is sent, so each of those calls sends the stored value. Version
 * previews stay on in every case: an update checks the new version on its
 * preview URL (`<8 hex>-<worker>.<subdomain>.workers.dev`), and a preview
 * keeps answering with the canonical URL off as long as `previews_enabled`
 * is sent as true. Turning `enabled` off without it turns previews off too.
 */

/** The body of the subdomain call for an app's Worker. */
export function workersDevSubdomain(enabled: boolean): {
  enabled: boolean;
  previews_enabled: true;
} {
  return { enabled, previews_enabled: true };
}

/**
 * The body of the subdomain call for Appflare's own Worker, which always
 * keeps its workers.dev URL: the setup link, the sign-in origin and the
 * installer's health check all use it.
 */
export const MANAGER_SUBDOMAIN = { enabled: true, previews_enabled: true } as const;

/** `https://<worker>.<subdomain>.workers.dev` */
export function workersDevBase(workerName: string, subdomain: string): string {
  return `https://${workerName}.${subdomain}.workers.dev`;
}

/**
 * The custom domain the app is reached on while workers.dev is off: the one
 * that answered when the switch was turned off, while it is still attached,
 * else the first one (by the order they were added); null with none.
 */
export function primaryDomain(
  domains: readonly string[],
  served: string | null | undefined,
): string | null {
  if (served != null && domains.includes(served)) return served;
  return domains[0] ?? null;
}

/**
 * Where the app is reached: its workers.dev URL while that is on, else its
 * primary custom domain (see `primaryDomain`). With neither, the workers.dev
 * URL, which then answers with Cloudflare's error 1042 page.
 */
export function appBaseUrl(input: {
  workerName: string;
  subdomain: string;
  workersDev: boolean;
  /** Hostnames of the install's custom domains, oldest first. */
  domains: readonly string[];
  /** `installs.served_domain`. */
  served?: string | null;
}): string {
  const domain = input.workersDev ? null : primaryDomain(input.domains, input.served);
  return domain === null ? workersDevBase(input.workerName, input.subdomain) : `https://${domain}`;
}

/**
 * The custom domain hostnames among recorded resources, oldest first. Their
 * ids end with a ULID, so sorting by id is sorting by when they were added.
 */
export function domainHostnames(
  rows: readonly { id: string; kind: string; name: string }[],
): string[] {
  return rows
    .filter((r) => r.kind === "domain")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => r.name);
}

export const setWorkersDevInput = z.object({
  installId: z.string().min(1).max(64),
  enabled: z.boolean(),
});
export type SetWorkersDevInput = z.infer<typeof setWorkersDevInput>;

export const WORKERS_DEV_COPY = {
  label: "Serve on workers.dev",
  onHelp: (url: string) => `The app also answers at ${url}.`,
  offHelp:
    "The app answers only on its custom domains. Update checks still use the Worker's preview URLs.",
  noDomain:
    "Add a custom domain and make sure it serves the app before you turn this off; the workers.dev URL is the app's only address until then.",
} as const;
