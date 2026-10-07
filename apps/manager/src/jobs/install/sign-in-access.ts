import { CloudflareApiError, failureDetail } from "@appflare/cf-api";
import { RECONNECT_PLACE } from "../../cloudflare/connection-errors";
import { JobError, type JobSteps } from "../steps";

/**
 * Before an install creates anything on a manager connected with Cloudflare
 * sign-in: one read that the sign-in may make in the account, the list of
 * its Workers (what every install needs first). It takes the place of the
 * API token check, whose verify endpoints answer 401 "Invalid API Token" to
 * any sign-in, however valid. The read also renews the access token when it
 * has run out, so a sign-in Cloudflare no longer accepts ends here with the
 * connection's own words.
 */

export const SIGN_IN_ACCESS_STEP = "check access to the Cloudflare account";

/** What the install says when Cloudflare refuses the sign-in in this account. */
export const SIGN_IN_REFUSED = `Cloudflare did not let Appflare into this account with its Cloudflare sign-in, so nothing was installed. An administrator can reconnect Cloudflare in ${RECONNECT_PLACE} and allow every permission Appflare asks for.`;

/**
 * One step, one request, and the account's Worker names it read, which the
 * Worker name check that follows uses instead of listing them again.
 */
export async function checkSignInPhase(steps: JobSteps): Promise<{ scripts: string[] }> {
  return steps.run(SIGN_IN_ACCESS_STEP, async ({ log, cf }) => {
    let scripts: string[];
    try {
      scripts = (await cf().workers.listScripts()).map((s) => s.id);
    } catch (error) {
      // Cloudflare busy or unreachable: the engine tries again.
      if (!(error instanceof CloudflareApiError) || error.status >= 500 || error.status === 429) {
        throw error;
      }
      log.warn(`Cloudflare refused to list the account's Workers (${failureDetail(error)}).`);
      throw new JobError(SIGN_IN_REFUSED);
    }
    log.info("Appflare's Cloudflare sign-in reaches this account.");
    return { scripts };
  });
}
