import { env } from "cloudflare:workers";
import { readAccessConfig } from "../access/config";
import { syncAppAccessUsers, UsersPolicyMissingError } from "../access/install-access.server";
import { syncAccessAdmins } from "../access/toggle.server";
import { getCfClient } from "../cloudflare/client.server";

/**
 * After an admin was added: brings the allow policy up to date when
 * protection is on. Never throws; the caller reports a failure next to the
 * otherwise successful change.
 */
export async function syncAccessAfterAdminChange(
  actorEmail: string,
): Promise<"off" | "updated" | "failed"> {
  try {
    if ((await readAccessConfig(env.DB)) === null) return "off";
    await syncAccessAdmins({ db: env.DB, client: await getCfClient(env), actorEmail });
    return "updated";
  } catch (error) {
    console.error("access: could not update the admins policy", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

/**
 * How "Appflare users" followed a user change: "missing" when it was deleted
 * in the dashboard (the cron makes it again; protected apps must then be
 * protected again to use it).
 */
export type AppAccessPolicyOutcome = "off" | "updated" | "failed" | "missing";

/**
 * After a user was added, deleted, or changed role: brings the "Appflare
 * users" policy of apps protected with Cloudflare Access up to date. "off"
 * while no app was ever protected (no Cloudflare call). Never throws; the
 * caller reports a failure next to the otherwise successful change, and the
 * cron tries again (`resyncAppAccessUsersIfFailed`).
 */
export async function syncAppAccessAfterUserChange(): Promise<AppAccessPolicyOutcome> {
  try {
    const result = await syncAppAccessUsers({ db: env.DB, client: () => getCfClient(env) });
    return result.on ? "updated" : "off";
  } catch (error) {
    console.error("access: could not update the users policy of protected apps", {
      error: error instanceof Error ? error.message : String(error),
    });
    return error instanceof UsersPolicyMissingError ? "missing" : "failed";
  }
}
