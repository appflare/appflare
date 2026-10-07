/**
 * Cloudflare's refusals as Appflare words them for an API token: which
 * permission the token lacks and how to add it. The modules that meet a
 * refusal build their message here, so the same words have one home; on a
 * manager connected with Cloudflare sign-in, `inConnectionWords`
 * (sign-in-words.ts) rewords each of them, and its tests build them here.
 * Client-safe.
 */
export const TOKEN_REFUSALS = {
  /** Attaching a custom domain to a Worker. */
  attachDomain: (hostname: string, zoneName: string, routes: string, dns: string) =>
    `Cloudflare refused to attach ${hostname}: the token needs ${routes} on ${zoneName} (and ${dns} to replace records). Add them to the token and try again.`,
  /** Reading a zone for a custom domain. */
  zoneHidden: (permissions: string) =>
    `The Cloudflare token cannot see that zone. It needs ${permissions} on it.`,
  /** Reading a zone for Email Routing. */
  emailZoneHidden: "The Cloudflare token cannot see that zone.",
  /** Reading the zone of the external domains gateway. */
  gatewayZoneHidden:
    "The Cloudflare token cannot see that domain. It needs Zone: Read, DNS: Edit and Workers Routes: Edit on it.",
  /** The domain an app receives email for, out of sight when a job sets the app's email up. */
  emailZoneGone: (zoneName: string, permissions: string) =>
    `Appflare cannot see ${zoneName}, the domain the app receives email for: it may have been removed from Cloudflare, or the token lacks ${permissions}.`,
  /** What setting up an app's email (`what`) lacks; no full stop, the caller goes on. */
  emailPermissions: (permissions: string, what: string) =>
    `the Cloudflare token lacks ${permissions}, which ${what} needs; add them to the token (for this zone)`,
  /** Listing Email Routing's destination addresses. */
  destinationAddresses: (permission: string) =>
    `The token cannot list the account's destination addresses (it needs ${permission}), so this page cannot show which ones are verified.`,
  /** A refused Email Routing call; no full stop, the caller ends the sentence. */
  emailRoutingCall: (what: string, said: string, permission: string) =>
    `Cloudflare refused to ${what} (${said}). The token needs ${permission} on the zone; add it to the token and try again`,
  /** A refused call on the gateway's zone. */
  gatewayCall: (zoneName: string, permission: string) =>
    `Cloudflare refused a call on ${zoneName}: the token needs ${permission} on it. Edit the token in the Cloudflare dashboard to add it, then try again.`,
  /** An uninstall step that could not remove a domain; no full stop. */
  removeDomain: (
    kind: "external domain" | "custom domain" | "wildcard domain",
    hostname: string,
    said: string,
    permission: string,
    where: "the gateway domain" | "its zone",
  ) =>
    `Cloudflare refused to remove the ${kind} ${hostname} (${said}). The token needs ${permission} on ${where}; add ${permission.includes(" and ") ? "them" : "it"} to the token and retry the uninstall`,
  /** A refused Hyperdrive call during an install; no full stop. */
  hyperdrive: (said: string, permission: string) =>
    `Cloudflare refused the Hyperdrive call (${said}). The API token needs ${permission}, an optional permission for apps with a database elsewhere: add it to the token in the Cloudflare dashboard, then try again`,
} as const;
