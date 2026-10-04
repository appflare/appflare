import {
  ACCESS_FEATURE,
  permissionName,
  splitPermissionGroups,
} from "../cloudflare/token-template";

/**
 * What Appflare says about Cloudflare Access: the manager's own protection
 * (`ACCESS_MESSAGES`) and the protection of installed apps
 * (`INSTALL_ACCESS_MESSAGES`). Client-safe, so the install form and the app
 * page say what the server refuses with in the same words.
 */

const ACCESS_GROUPS = splitPermissionGroups().optional.filter((g) => g.onlyFor === ACCESS_FEATURE);
const nameOf = (key: string, fallback: string) => {
  const group = ACCESS_GROUPS.find((g) => g.key === key);
  return group === undefined ? fallback : permissionName(group);
};

/** The token permissions protecting with Cloudflare Access needs, as the dashboard names them. */
export const ACCESS_PERMISSIONS = {
  apps: nameOf("access", "Access: Apps and Policies: Edit"),
  organization: nameOf(
    "access_acct",
    "Access: Organizations, Identity Providers, and Groups: Read",
  ),
  serviceTokens: nameOf("access_service_token", "Access: Service Tokens: Edit"),
} as const;

/** The reusable Access policy every protected app references: every Appflare user who is not banned. */
export const USERS_POLICY_NAME = "Appflare users";

export const ACCESS_MESSAGES = {
  appsPermission: `The Cloudflare token cannot manage Access applications. Add the ${ACCESS_PERMISSIONS.apps} permission to the token, then rotate it under Cloudflare token.`,
  organizationPermission: `The Cloudflare token cannot read the account's Zero Trust organization. Add the ${ACCESS_PERMISSIONS.organization} permission to the token, then rotate it under Cloudflare token.`,
  noOrganization:
    "This Cloudflare account has no Zero Trust organization yet. Create one in the Cloudflare dashboard (Zero Trust; the Free plan covers up to 50 users), then try again.",
  appExists: (name: string) =>
    `An Access application for this hostname already exists ("${name}"). Delete it in the Zero Trust dashboard, or keep using it and leave this setting off.`,
  unsupportedHost: (hostname: string) =>
    `Cloudflare Access cannot protect "${hostname}". Open the manager at its workers.dev address or custom domain and try again.`,
  alreadyOn: "Cloudflare Access protection is already on.",
  busy: "Another Access change is in progress. Try again in a minute.",
  keysUnreachable:
    "The Access application was created, but the team's signing keys could not be fetched, so protection was not turned on and the application was removed. Try again in a minute.",
  policyMissing:
    "The Access policy for the manager no longer exists. Turn protection off and on again to recreate it.",
  appMissing:
    "The Cloudflare Access application for the manager no longer exists. Turn protection off and on again to recreate it.",
} as const;

export const INSTALL_ACCESS_MESSAGES = {
  policiesPermission: `The Cloudflare token cannot manage Access applications and policies. Add the ${ACCESS_PERMISSIONS.apps} permission to the token, then rotate it under Cloudflare token.`,
  tokensPermission: `The Cloudflare token cannot manage Access service tokens. Add the ${ACCESS_PERMISSIONS.serviceTokens} permission to the token, then rotate it under Cloudflare token.`,
  unchecked: (detail: string) =>
    `Appflare could not ask Cloudflare whether this account and its Cloudflare token can protect apps with Cloudflare Access (${detail}), so nothing was started. Try again in a minute.`,
  noAuthSecret:
    "This Worker has no BETTER_AUTH_SECRET, so Appflare cannot keep a service token's secret safely.",
  noUsers: "There are no Appflare users to allow through Cloudflare Access.",
  usersPolicyMissing: `The "${USERS_POLICY_NAME}" Access policy was deleted in the Cloudflare dashboard. Appflare makes it again within 30 minutes; each protected app's page then offers "Protect again", which lets people sign in to it again.`,
  notRecorded: "This app has no Cloudflare Access service token recorded.",
  tokenMissing:
    "This app's Cloudflare Access service token no longer exists. Protecting the app again makes a new one.",
  tokenInUse:
    "This app's Cloudflare Access service token is still named in an Access policy. Remove the app's Access application (or the token from its policy) first, then try again.",
} as const;
