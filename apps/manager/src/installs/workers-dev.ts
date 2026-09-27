import { z } from "zod";

/**
 * An install's workers.dev URL (`<worker>.<subdomain>.workers.dev`): on for
 * a new install, turned off by Appflare once a custom or external domain
 * serves the app (see `WORKERS_DEV_CHOICES`), and switchable on the app page
 * ("Serve on workers.dev") while a domain serves it. Client-safe (no bindings).
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
 * The body of the subdomain call for a Worker of an app that its catalog
 * entry keeps off workers.dev (`install.workers[].workersDev: false`): the
 * app's other Workers reach it through their bindings, and nothing else may.
 * Previews go off too, since a preview URL answers from the internet as well.
 */
export const OFF_WORKERS_DEV = { enabled: false, previews_enabled: false } as const;

/**
 * The body of the subdomain call for Appflare's own Worker, which always
 * keeps its workers.dev URL: the address the installer prints, the sign-in
 * origin and the installer's health check all use it.
 */
export const MANAGER_SUBDOMAIN = { enabled: true, previews_enabled: true } as const;

/** `https://<worker>.<subdomain>.workers.dev` */
export function workersDevBase(workerName: string, subdomain: string): string {
  return `https://${workerName}.${subdomain}.workers.dev`;
}

/**
 * The domain the app is reached on while workers.dev is off: the one that
 * answered when it was turned off, while it is still attached, else the
 * first of `domains` (live ones first, see `domainHostnames`); null with none.
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
 * The hostnames of the custom, external and wildcard domains among recorded
 * resources (a wildcard domain by its base hostname, which the app answers
 * on too): the live ones (a request through them reached the app) first,
 * then the others, each oldest first. Their ids end with a ULID, so sorting
 * by id is sorting by when they were added. Rows read without `live_at`
 * all count the same.
 */
export function domainHostnames(
  rows: readonly { id: string; kind: string; name: string; live_at?: Date | number | null }[],
): string[] {
  const rank = (r: { live_at?: Date | number | null }) => (r.live_at != null ? 0 : 1);
  return rows
    .filter(
      (r) => r.kind === "domain" || r.kind === "custom_hostname" || r.kind === "wildcard_domain",
    )
    .sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => r.name);
}

/**
 * Who sets an install's workers.dev switch. `auto` (every install starts so):
 * Appflare turns workers.dev off once a custom or external domain answers as
 * the app, and back on when the last such domain is removed, so the app
 * always keeps an address. `manual`: an admin used the switch, and Appflare
 * leaves it where they put it.
 */
export const WORKERS_DEV_CHOICES = ["auto", "manual"] as const;
export type WorkersDevChoice = (typeof WORKERS_DEV_CHOICES)[number];

/** Why a domain going live left workers.dev as it was. */
export type WorkersDevKeptReason =
  /** An admin set the switch on this install. */
  | "manual"
  /** It is off already. */
  | "off"
  /** The app's own installer decides where its Workers answer. */
  | "self-deploying"
  /** The Worker's settings hold its workers.dev URL (`{{workerUrl}}`). */
  | "settings"
  /** A job of the app is running; the next check through the domain tries again. */
  | "busy";

export type DomainLiveOutcome =
  | { action: "turn-off" }
  | { action: "keep"; reason: WorkersDevKeptReason };

/**
 * What a custom or external domain answering as the app does to workers.dev:
 * turned off while the choice is `auto`, unless the Worker's settings were
 * filled in with its workers.dev URL, which would then point nowhere until
 * the settings are saved again.
 */
export function workersDevWhenDomainLive(state: {
  choice: WorkersDevChoice;
  enabled: boolean;
  selfDeploying: boolean;
  settingsUseWorkersDevUrl: boolean;
}): DomainLiveOutcome {
  if (state.selfDeploying) return { action: "keep", reason: "self-deploying" };
  if (!state.enabled) return { action: "keep", reason: "off" };
  if (state.choice === "manual") return { action: "keep", reason: "manual" };
  if (state.settingsUseWorkersDevUrl) return { action: "keep", reason: "settings" };
  return { action: "turn-off" };
}

export type DomainRemovalOutcome =
  | { action: "keep" }
  | { action: "turn-on" }
  | { action: "refuse"; message: string };

/**
 * What removing a custom or external domain does to workers.dev. With
 * workers.dev off and no other live domain left, the app would have no
 * address: an `auto` switch is turned back on first; a `manual` one makes
 * the removal wait for the admin.
 */
export function workersDevWhenDomainRemoved(state: {
  choice: WorkersDevChoice;
  enabled: boolean;
  /** The install's other domains that answer as the app. */
  otherLiveDomains: number;
}): DomainRemovalOutcome {
  if (state.enabled || state.otherLiveDomains > 0) return { action: "keep" };
  if (state.choice === "auto") return { action: "turn-on" };
  return {
    action: "refuse",
    message:
      "This is the app's only address: its workers.dev URL is off. Turn on Serve on workers.dev first, or add another domain.",
  };
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
    "The app answers only on its custom and external domains. Update checks still use the Worker's preview URLs.",
  /** The one-line note while Appflare turned it off. */
  autoOff: "workers.dev turned off because a domain is live",
  /** Why a live domain left it on: the Worker's settings hold the URL. */
  settingsKeep:
    "workers.dev stays on because the app's settings use its workers.dev URL. To turn it off, turn off this switch, then save the app's settings so they use the domain.",
  noDomain:
    "Add a custom or external domain and make sure it serves the app before you turn this off; the workers.dev URL is the app's only address until then.",
  /** The install form, once a domain is chosen. */
  installNote: "workers.dev will be turned off once the domain is live",
} as const;
