import { CloudflareApiError, type CloudflareClient, isAccessTeamDomain } from "@appflare/cf-api";
import type { AppAccessProblem } from "./app-access";
import { ACCESS_MESSAGES, INSTALL_ACCESS_MESSAGES } from "./messages";

/**
 * Whether the account and the Cloudflare token can protect an app with
 * Cloudflare Access, checked before an install or a change of protection
 * starts, with the words the protection itself refuses with: a Zero Trust
 * organization with a `cloudflareaccess.com` team domain, the organization
 * readable, Access applications and policies, and Access service tokens.
 *
 * Reads only (three list calls), so it proves the token can read these, not
 * that it can edit them; a token with Read alone is refused by the job's
 * first write, before anything of the app exists. A check that fails for
 * another reason (Cloudflare unreachable) is not a refusal here: the job
 * checks again.
 */

function status(error: unknown): number | null {
  return error instanceof CloudflareApiError ? error.status : null;
}

const refused = (error: unknown) => status(error) === 401 || status(error) === 403;

/** What stands in the way of protecting an app now, and where it is fixed; null when nothing does. */
export async function accessCapabilityCheck(
  client: Pick<CloudflareClient, "access">,
): Promise<AppAccessProblem | null> {
  try {
    const domain = (await client.access.getOrganization()).auth_domain;
    if (!isAccessTeamDomain(domain)) {
      return {
        kind: "team-domain",
        message: `The Zero Trust organization's team domain "${domain}" is not a cloudflareaccess.com domain, which Appflare cannot verify tokens from.`,
      };
    }
  } catch (error) {
    if (status(error) === 404) {
      return { kind: "no-organization", message: ACCESS_MESSAGES.noOrganization };
    }
    if (refused(error)) {
      return { kind: "organization-permission", message: ACCESS_MESSAGES.organizationPermission };
    }
    return null;
  }
  try {
    await client.access.listApps();
  } catch (error) {
    if (refused(error)) {
      return { kind: "policies-permission", message: INSTALL_ACCESS_MESSAGES.policiesPermission };
    }
  }
  try {
    await client.access.listServiceTokens();
  } catch (error) {
    if (refused(error)) {
      return { kind: "tokens-permission", message: INSTALL_ACCESS_MESSAGES.tokensPermission };
    }
  }
  return null;
}

/** Why the account cannot protect an app now, in the admin's words; null when it can. */
export async function accessCapabilityProblem(
  client: Pick<CloudflareClient, "access">,
): Promise<string | null> {
  return (await accessCapabilityCheck(client))?.message ?? null;
}
