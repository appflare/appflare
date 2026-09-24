import { z } from "zod";

/**
 * Client-safe input of the custom domain server functions, and the hostname
 * rule both sides apply: a hostname the add dialog accepts is one the server
 * accepts.
 */

const installId = z.string().min(1).max(64);

export const addCustomDomainInput = z.object({
  installId,
  zoneId: z.string().min(1).max(64),
  hostname: z.string().min(1).max(300),
  /** The admin ticked "replace the existing DNS records" after being warned. */
  overrideExistingDnsRecord: z.boolean().optional(),
});
export type AddCustomDomainInput = z.infer<typeof addCustomDomainInput>;

export const customDomainInput = z.object({
  installId,
  /** The `resources` row of the custom domain. */
  resourceId: z.string().min(1).max(200),
});
export type CustomDomainInput = z.infer<typeof customDomainInput>;

/** A DNS label in Punycode: letters, digits, and inner hyphens, 1 to 63 long. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export type HostnameCheck = { ok: true; hostname: string } | { ok: false; error: string };

/**
 * Normalizes what the admin typed (trimmed, lower case, no trailing dot,
 * international names in Punycode) and checks it is a hostname Cloudflare can
 * serve a Worker on in the zone `zoneName`: the zone itself or a name under it,
 * with no wildcard, because a custom domain matches one exact hostname.
 */
export function checkHostnameInZone(input: string, zoneName: string): HostnameCheck {
  const zone = zoneName.trim().toLowerCase().replace(/\.$/, "");
  let hostname = input.trim().toLowerCase().replace(/\.$/, "");
  if (hostname.length === 0) return { ok: false, error: "Enter a hostname." };
  if (hostname.includes("*")) {
    return {
      ok: false,
      error: "A custom domain is one exact hostname; wildcards are not allowed.",
    };
  }
  if (/[/:?#@\s]/.test(hostname)) {
    return {
      ok: false,
      error: `Enter only the hostname, such as app.${zone}, without https:// or a path.`,
    };
  }
  try {
    // The URL parser applies IDNA, so an international name becomes its Punycode form.
    hostname = new URL(`https://${hostname}/`).hostname;
  } catch {
    return { ok: false, error: `"${input.trim()}" is not a valid hostname.` };
  }
  const labels = hostname.split(".");
  if (hostname.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    return { ok: false, error: `"${input.trim()}" is not a valid hostname.` };
  }
  if (hostname !== zone && !hostname.endsWith(`.${zone}`)) {
    return { ok: false, error: `The hostname must be ${zone} or end in .${zone}.` };
  }
  return { ok: true, hostname };
}

/** What a domain field shows in place of a subdomain that is left empty. */
export const ROOT_DOMAIN_PLACEHOLDER = "Leave empty for the root domain";

/**
 * The hostname in zone `zoneName` that a domain field means, where the zone
 * is a fixed suffix and the admin types only what comes before it: empty is
 * the zone itself (its root, or apex), which Workers Custom Domains serve
 * like any other name. A whole hostname in the zone, pasted in full, is taken
 * as it is rather than doubling the zone; any other dotted name is refused
 * (a deeper name is typed in full). The result is then checked like
 * any hostname in the zone (checkHostnameInZone), which is also what the
 * server applies to the hostname it receives.
 */
export function checkSubdomainInZone(input: string, zoneName: string): HostnameCheck {
  const zone = zoneName.trim().toLowerCase().replace(/\.$/, "");
  const typed = input.trim().toLowerCase().replace(/\.+$/, "");
  if (/[/:?#@\s]/.test(typed)) {
    return {
      ok: false,
      error: `Enter only the name before .${zone}, such as app, without https:// or a path.`,
    };
  }
  if (typed.length === 0) return checkHostnameInZone(zone, zone);
  if (typed === zone || typed.endsWith(`.${zone}`)) return checkHostnameInZone(typed, zone);
  // A dotted name that does not end in the zone is most likely another
  // domain typed in full ("evil.com"), not a name meant to go under the zone.
  if (typed.includes(".")) {
    return { ok: false, error: `Enter a name under ${zone}, or leave empty for the root.` };
  }
  return checkHostnameInZone(`${typed}.${zone}`, zone);
}
