import { CloudflareApiError, type CloudflareClient, isAccessTeamDomain } from "@appflare/cf-api";
import { inConnectionWordsOf } from "../cloudflare/sign-in-words.server";
import type { AppAccessProblem } from "./app-access";
import { ACCESS_MESSAGES, INSTALL_ACCESS_MESSAGES } from "./messages";

/**
 * Whether the account and the Cloudflare token can protect an app with
 * Cloudflare Access, checked live before an install or a change of
 * protection starts, with the words the protection itself refuses with: a
 * Zero Trust organization with a `cloudflareaccess.com` team domain, the
 * organization readable, Access applications and policies, and Access
 * service tokens. Never from the stored account checks: those may predate
 * the token's last change, or come from a version that did not check
 * service tokens at all.
 *
 * Reads only (three list calls), so it proves the token can read these, not
 * that it can edit them; a token with Read alone is refused by the job's
 * first write, before anything of the app exists. A read that fails for
 * another reason (Cloudflare unreachable) leaves that part unchecked: the
 * install form shows nothing for it, and starting protection refuses until
 * a check gets an answer (`accessCapabilityProblem`).
 */

function status(error: unknown): number | null {
  return error instanceof CloudflareApiError ? error.status : null;
}

const refused = (error: unknown) => status(error) === 401 || status(error) === 403;

const detailOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the three reads found: what stands in the way, and what they could not tell. */
export interface AccessCapabilityReport {
  /** The first thing that stands in the way, null when none was found. */
  problem: AppAccessProblem | null;
  /** Why a read gave no answer (not a refusal of the token); null when every read answered. */
  unchecked: string | null;
}

export async function accessCapabilityReport(
  client: Pick<CloudflareClient, "access">,
): Promise<AccessCapabilityReport> {
  let unchecked: string | null = null;
  const fail = (error: unknown) => {
    unchecked ??= detailOf(error);
  };
  try {
    const domain = (await client.access.getOrganization()).auth_domain;
    if (!isAccessTeamDomain(domain)) {
      return {
        problem: {
          kind: "team-domain",
          message: `The Zero Trust organization's team domain "${domain}" is not a cloudflareaccess.com domain, which Appflare cannot verify tokens from.`,
        },
        unchecked: null,
      };
    }
  } catch (error) {
    if (status(error) === 404) {
      return {
        problem: { kind: "no-organization", message: ACCESS_MESSAGES.noOrganization },
        unchecked: null,
      };
    }
    if (refused(error)) {
      return {
        problem: {
          kind: "organization-permission",
          message: ACCESS_MESSAGES.organizationPermission,
        },
        unchecked: null,
      };
    }
    // The organization could not be read: the permissions below still can be.
    fail(error);
  }
  try {
    await client.access.listApps();
  } catch (error) {
    if (refused(error)) {
      return {
        problem: {
          kind: "policies-permission",
          message: INSTALL_ACCESS_MESSAGES.policiesPermission,
        },
        unchecked: null,
      };
    }
    fail(error);
  }
  try {
    await client.access.listServiceTokens();
  } catch (error) {
    if (refused(error)) {
      return {
        problem: { kind: "tokens-permission", message: INSTALL_ACCESS_MESSAGES.tokensPermission },
        unchecked: null,
      };
    }
    fail(error);
  }
  return { problem: null, unchecked };
}

/**
 * What stands in the way of protecting an app now, and where it is fixed;
 * null when nothing was found. For showing: a read without an answer is not
 * a problem here.
 */
export async function accessCapabilityCheck(
  client: Pick<CloudflareClient, "access">,
  /** The manager's D1: a refusal is then worded for how Appflare connects. */
  db?: D1Database,
): Promise<AppAccessProblem | null> {
  const { problem } = await accessCapabilityReport(client);
  return problem === null || db === undefined
    ? problem
    : { ...problem, message: await inConnectionWordsOf(db, problem.message) };
}

/** Why protection cannot start now (`accessCapabilityProblem`). */
export interface AccessPreflightProblem {
  /** In the admin's words. */
  message: string;
  /**
   * Cloudflare gave no answer, so nothing is known to stand in the way; the
   * message says to try again, and reads on its own.
   */
  unchecked: boolean;
}

/**
 * Why protection cannot start now; null when it can. The gate every start
 * of protection passes, before anything is created: a read that gave no
 * answer refuses too, since protection must never start on a permission
 * nobody checked.
 */
export async function accessCapabilityProblem(
  client: Pick<CloudflareClient, "access">,
  /** The manager's D1: a refusal is then worded for how Appflare connects. */
  db?: D1Database,
): Promise<AccessPreflightProblem | null> {
  const report = await accessCapabilityReport(client);
  if (report.problem !== null) {
    const { message } = report.problem;
    return {
      message: db === undefined ? message : await inConnectionWordsOf(db, message),
      unchecked: false,
    };
  }
  return report.unchecked === null
    ? null
    : { message: INSTALL_ACCESS_MESSAGES.unchecked(report.unchecked), unchecked: true };
}

/**
 * Why an install of `appName` protected with Cloudflare Access is refused:
 * what the account or the token lacks, or, when Cloudflare could not be
 * asked, only that (the account is not known to lack anything).
 */
export function accessInstallRefusal(appName: string, problem: AccessPreflightProblem): string {
  return problem.unchecked
    ? problem.message
    : `${appName} needs Cloudflare Access, which this account cannot provide yet: ${problem.message}`;
}
