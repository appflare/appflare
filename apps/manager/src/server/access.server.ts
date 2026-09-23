import { env } from "cloudflare:workers";
import { readAccessConfig } from "../access/config";
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
