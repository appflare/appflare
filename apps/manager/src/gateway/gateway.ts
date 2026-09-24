import { z } from "zod";

/**
 * External domains: hostnames in someone else's DNS that serve an installed
 * app, through Cloudflare for SaaS custom hostnames on one zone of the
 * account, the gateway zone. Client-safe (no bindings): names, the hostname
 * rule, and the wording both the Settings page and the app page use.
 *
 * How a request reaches the app: the owner points a CNAME at the gateway's
 * hostname in the gateway zone; Cloudflare validates the custom hostname and
 * issues its certificate; the gateway Worker, on the route that matches every
 * request of the zone, looks the hostname up in its routing table and hands
 * the request to the app's Worker over a service binding. Per-hostname routes
 * are not used because they do not match when the owner's CNAME is proxied
 * from another Cloudflare account; the catch-all route does.
 */

/** The gateway Worker the manager deploys into the account. */
export const GATEWAY_WORKER_NAME = "appflare-gateway";

/** The gateway's own hostname in the gateway zone: the CNAME target and fallback origin. */
export const GATEWAY_HOST_LABEL = "appflare-gateway";

/** The gateway's routing table (hostname -> service binding name). */
export const GATEWAY_KV_TITLE = "appflare-gateway-routes";

/** The gateway Worker's KV binding. */
export const GATEWAY_ROUTES_BINDING = "ROUTES";

/**
 * The version of gateway-worker.js. Raise it whenever that file changes: a
 * gateway running older code is uploaded again, with its service bindings,
 * the next time one of them changes.
 */
export const GATEWAY_CODE_VERSION = "2";

/** The route pattern that matches every request of the gateway zone. */
export const GATEWAY_ROUTE_PATTERN = "*/*";

/** Where external domains point their CNAME. */
export function gatewayHostname(zoneName: string): string {
  return `${GATEWAY_HOST_LABEL}.${zoneName}`;
}

/**
 * The gateway's service binding to an install's Worker: one per install,
 * named after its id (a ULID, so a valid identifier once upper-cased), and
 * shared by all of the install's external domains.
 */
export function gatewayBindingName(installId: string): string {
  return `APP_${installId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * How the owner proves the hostname: `http`, a CNAME to the gateway (live in
 * about a minute and a half); `txt`, TXT records first, then the CNAME, so a
 * name that already serves a site moves without downtime.
 */
export const VALIDATION_METHODS = ["http", "txt"] as const;
export type ValidationMethod = (typeof VALIDATION_METHODS)[number];

export const VALIDATION_LABELS: Record<ValidationMethod, { label: string; help: string }> = {
  http: {
    label: "CNAME",
    help: "For a name that serves nothing yet. Add one CNAME record; the domain is live about a minute and a half later.",
  },
  txt: {
    label: "TXT records first",
    help: "For a name that already serves a site. Add TXT records; once the certificate is ready, change the CNAME and nothing goes down.",
  },
};

/** A zone id as Cloudflare prints it (32 hex); refused otherwise. */
export const zoneIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Choose a domain.");

/** The price, as Cloudflare lists it for Cloudflare for SaaS on every plan. */
export const EXTERNAL_DOMAIN_COST =
  "Cloudflare for SaaS includes 100 external domains per account at no charge; each one beyond that costs $0.10 a month. Every request to an external domain, and every request to the gateway domain's own sites, runs the gateway Worker first and counts toward the account's Workers requests.";

/**
 * The dashboard page where a person turns Cloudflare for SaaS on for a zone
 * (SSL/TLS > Custom Hostnames). Cloudflare asks for a payment method there
 * even though the first 100 hostnames cost nothing.
 */
export function saasDashboardUrl(accountId: string | null, zoneName: string): string {
  return `https://dash.cloudflare.com/${accountId ?? ":account"}/${encodeURIComponent(zoneName)}/ssl-tls/custom-hostnames`;
}

export type ZoneSaasCheck =
  | { kind: "ready"; used: number | null; allocated: number | null }
  | { kind: "saas-off"; dashboardUrl: string }
  | { kind: "missing-permission"; permission: string }
  | { kind: "error"; message: string };

/** What a {@link ZoneSaasCheck} that is not ready asks the admin to do. */
export function saasCheckMessage(check: ZoneSaasCheck, zoneName: string): string | null {
  switch (check.kind) {
    case "ready":
      return null;
    case "saas-off":
      return `Cloudflare for SaaS is off for ${zoneName}. Turn it on in the Cloudflare dashboard (${zoneName}, SSL/TLS, Custom Hostnames, Enable Cloudflare for SaaS); Cloudflare asks for a payment method there, though the first 100 external domains cost nothing. Then check again.`;
    case "missing-permission":
      return `The Cloudflare token lacks ${check.permission} on ${zoneName}, which external domains need. Edit the token in the Cloudflare dashboard to add it (an edited token keeps its value), then check again.`;
    case "error":
      return check.message;
  }
}

/** A DNS label in Punycode: letters, digits, and inner hyphens, 1 to 63 long. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export type ExternalHostnameCheck =
  | {
      ok: true;
      hostname: string;
      /** Only two labels: the owner's DNS host must flatten a CNAME at the apex. */
      apex: boolean;
    }
  | { ok: false; error: string };

function underZone(hostname: string, zone: string): boolean {
  return hostname === zone || hostname.endsWith(`.${zone}`);
}

/**
 * Normalizes what the admin typed (trimmed, lower case, no trailing dot,
 * international names in Punycode) and checks it can be an external domain:
 * one exact hostname (Cloudflare offers wildcard custom hostnames on
 * Enterprise only), not the gateway zone or a name under it (Cloudflare
 * accepts that but advises against it, and those names pass through the
 * gateway to the zone's own origin), and not under another zone of this
 * account (a custom domain serves those without Cloudflare for SaaS).
 */
export function checkExternalHostname(
  input: string,
  zones: { gateway: string; account: readonly string[] },
): ExternalHostnameCheck {
  let hostname = input.trim().toLowerCase().replace(/\.$/, "");
  if (hostname.length === 0) return { ok: false, error: "Enter a hostname." };
  if (hostname.includes("*")) {
    return {
      ok: false,
      error:
        "An external domain is one exact hostname; wildcards need Cloudflare's Enterprise plan.",
    };
  }
  if (/[/:?#@\s]/.test(hostname)) {
    return {
      ok: false,
      error: "Enter only the hostname, such as app.example.org, without https:// or a path.",
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
  const gateway = zones.gateway.toLowerCase();
  if (underZone(hostname, gateway)) {
    return {
      ok: false,
      error: `${hostname} is in the gateway domain ${gateway}. Use a custom domain for names in your own domains.`,
    };
  }
  const own = zones.account.map((z) => z.toLowerCase()).find((z) => underZone(hostname, z));
  if (own !== undefined) {
    return {
      ok: false,
      error: `${hostname} is in ${own}, a domain in this Cloudflare account. Add it as a custom domain instead; it needs no gateway.`,
    };
  }
  return { ok: true, hostname, apex: labels.length === 2 };
}

/** One DNS record the domain's owner adds, as the app page shows it. */
export interface OwnerRecord {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  /** What the record is for, in one sentence. */
  purpose: string;
}
