import { z } from "zod";
import { checkHostnameInZone, checkSubdomainInZone } from "./custom-domain-input";
import { WILDCARD_DOMAIN_KIND } from "./resource-kinds";

/**
 * Wildcard domains, client-safe: the input of their server functions, the
 * rule both sides apply to the base hostname, and the words the dialogs and
 * the app page use.
 *
 * An app whose catalog manifest sets `install.wildcardHostname` answers on
 * every name under one hostname the admin assigns (the base): a tunnel gives
 * each session `<id>.<base>`. Workers custom domains match one exact
 * hostname, so the base is served through two proxied DNS records (the base
 * and `*.<base>`) and two Workers routes (`<base>/*` and `*.<base>/*`) in
 * one of the account's zones. Cloudflare for SaaS offers wildcard custom
 * hostnames on the Enterprise plan only, so there is no external wildcard
 * domain.
 */

const installId = z.string().min(1).max(64);

export const addWildcardDomainInput = z.object({
  installId,
  zoneId: z.string().min(1).max(64),
  /** The base hostname: the zone itself or a name under it. */
  hostname: z.string().min(1).max(300),
  /**
   * The admin agreed that the base is the zone itself, so every name in the
   * zone reaches the app.
   */
  wholeDomain: z.boolean().optional(),
});
export type AddWildcardDomainInput = z.infer<typeof addWildcardDomainInput>;

/** The names under `base` the app answers on, as people write them. */
export function wildcardPattern(base: string): string {
  return `*.${base}`;
}

/** The DNS records a wildcard domain needs, by name: the base, then every name under it. */
export function wildcardRecordNames(base: string): [string, string] {
  return [base, wildcardPattern(base)];
}

/** The Workers route patterns a wildcard domain needs: the base, then every name under it. */
export function wildcardRoutePatterns(base: string): [string, string] {
  return [`${base}/*`, `${wildcardPattern(base)}/*`];
}

export type WildcardBaseCheck =
  | {
      ok: true;
      hostname: string;
      /** The base is the zone itself: every name in the zone reaches the app. */
      wholeDomain: boolean;
      /**
       * Names under the base are two levels below the zone, which the zone's
       * free certificate does not cover (see `wildcardCertificateNote`).
       */
      needsCertificate: boolean;
    }
  | { ok: false; error: string };

/**
 * Checks a base hostname the admin typed, as `checkHostnameInZone` checks a
 * custom domain (the base is one hostname; the app gets every name under
 * it), and says what the admin should know about it.
 */
export function checkWildcardBase(input: string, zoneName: string): WildcardBaseCheck {
  if (input.trim().startsWith("*.")) {
    return {
      ok: false,
      error: `Enter the hostname without "*."; the app gets every name under it.`,
    };
  }
  const checked = checkHostnameInZone(input, zoneName);
  if (!checked.ok) return checked;
  const zone = zoneName.trim().toLowerCase().replace(/\.$/, "");
  const wholeDomain = checked.hostname === zone;
  return { ok: true, hostname: checked.hostname, wholeDomain, needsCertificate: !wholeDomain };
}

/**
 * `checkWildcardBase` for a domain field where the zone is a fixed suffix
 * and the admin types what comes before it (see `checkSubdomainInZone`):
 * empty is the zone itself.
 */
export function checkWildcardSubdomain(input: string, zoneName: string): WildcardBaseCheck {
  if (input.trim().startsWith("*")) {
    return {
      ok: false,
      error: `Enter the name without "*."; the app gets every name under it.`,
    };
  }
  const checked = checkSubdomainInZone(input, zoneName);
  if (!checked.ok) return checked;
  return checkWildcardBase(checked.hostname, zoneName);
}

/**
 * What `{{wildcardHostname}}` becomes for an install: the base hostname of
 * its wildcard domain among its recorded resources (not deleted or kept),
 * null when it has none.
 */
export function wildcardHostnameOf(
  rows: ReadonlyArray<{ kind: string; name: string }>,
): string | null {
  return rows.find((r) => r.kind === WILDCARD_DOMAIN_KIND)?.name ?? null;
}

/** How a domain of an install is named in lists: a wildcard domain as `*.<base>`. */
export function domainLabel(domain: { hostname: string; wildcard: boolean }): string {
  return domain.wildcard ? wildcardPattern(domain.hostname) : domain.hostname;
}

/**
 * Why a wildcard name needs a certificate of its own. Verified in
 * Cloudflare's Universal SSL docs ("Limitations"): the free certificate
 * covers the zone and first-level names only, and names further down need
 * Advanced Certificate Manager (Total TLS) or an uploaded certificate.
 */
export function wildcardCertificateNote(base: string, zoneName: string): string {
  return `Cloudflare's free certificate for ${zoneName} covers ${zoneName} and the names one level under it, so https://${base} works, but names under it such as https://abc.${base} have no valid certificate until ${zoneName} has one for ${wildcardPattern(base)}: turn on Total TLS (Advanced Certificate Manager, a paid add-on) for ${zoneName}, or upload a certificate that covers it. A domain kept for this app, used at its root (leave the name empty), needs no extra certificate: the free one covers every name one level under it.`;
}

/** What assigning the zone itself means; the admin agrees to it before it is added. */
export function wholeDomainWarning(zoneName: string): string {
  return `Every name in ${zoneName} then reaches this app, including names that serve something else through Cloudflare's proxy now. Use a domain kept for this app, or a name under ${zoneName}.`;
}

/** The label of the box that agrees to `wholeDomainWarning`. */
export function wholeDomainConsent(zoneName: string): string {
  return `Serve every name in ${zoneName} with this app`;
}

/**
 * Why an app that needs a wildcard hostname cannot get an external domain.
 * Cloudflare for SaaS offers wildcard custom hostnames on the Enterprise
 * plan only (its plans table; a live create of `*.<name>` on a Free zone
 * was refused with code 1456, "Wildcard usage is only available on an
 * Enterprise plan").
 */
export const WILDCARD_EXTERNAL_REFUSAL =
  "This app needs every name under its hostname, and Cloudflare offers that for domains held outside the account (wildcard custom hostnames) on the Enterprise plan only. Use a domain on this Cloudflare account instead.";

/** What the address section says about an app that needs a wildcard hostname. */
export const WILDCARD_EXPLAINER =
  "Choose a hostname, such as tunnels.example.com, in one of this account's domains. The app answers on it and on every name under it (*.tunnels.example.com): Appflare adds proxied DNS records and Workers routes for both, since a custom domain matches one exact name.";

const wildcardManifest = z.object({
  catalog: z.object({
    install: z.object({
      wildcardHostname: z.boolean().optional(),
      wildcardReason: z.string().optional(),
    }),
  }),
});

/**
 * Whether an install's recorded manifest (`installs.manifest_json`, verified
 * when it was installed) asks for a wildcard hostname, with the catalog's
 * reason; null when it does not or cannot be read.
 */
export function wildcardOfManifest(manifestJson: string | null): { reason: string } | null {
  if (manifestJson === null) return null;
  try {
    const parsed = wildcardManifest.safeParse(JSON.parse(manifestJson));
    if (!parsed.success || parsed.data.catalog.install.wildcardHostname !== true) return null;
    return { reason: parsed.data.catalog.install.wildcardReason ?? "" };
  } catch {
    return null;
  }
}
