import type { CloudflareClient } from "@appflare/cf-api";
import type { BypassChange } from "./bypass.server";
import {
  readInstallProtection,
  recordAccessSyncFailure,
  syncInstallAccessDestinations,
} from "./protect.server";

/**
 * Around a change of an install's addresses outside a job (a custom or
 * wildcard domain added or removed, workers.dev turned on or off): its
 * Cloudflare Access applications in step with them, above all its public
 * paths (`access.bypass`), which are made public per hostname. Nothing, and
 * no Cloudflare call, for an app Appflare does not protect.
 *
 * Called with the coming change (`BypassChange`) before an address stops
 * serving the app, so a released hostname never keeps a public path, and
 * without one after an address was added, from the records.
 *
 * Never throws: it answers why it failed (another Access change holding the
 * lock, a missing permission), or null. The failure is also recorded on the
 * install, and the cron tries again (`resyncInstallAccessIfFailed`). A
 * caller removing a domain stops when the sync ahead of it fails, so the
 * hostname is never released with a public path left on it; after an
 * address was added, a failure only means it asks for a sign-in on the
 * public paths too until the retry.
 */
export type AccessAddressSync = (
  installId: string,
  change?: BypassChange,
) => Promise<string | null>;

export function accessAddressSync(
  db: D1Database,
  client: () => Promise<CloudflareClient>,
  now?: () => Date,
): AccessAddressSync {
  return async (installId, change) => {
    try {
      if ((await readInstallProtection(db, installId)) === null) return null;
      await syncInstallAccessDestinations(
        { db, client: await client(), ...(now === undefined ? {} : { now }) },
        installId,
        change === undefined ? {} : { change },
      );
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("access: the app's Access applications were not brought in step", {
        installId,
        error: message,
      });
      await recordAccessSyncFailure(db, installId, (now ?? (() => new Date()))()).catch(
        () => undefined,
      );
      return message;
    }
  };
}

/**
 * Why a domain was not removed: its public paths could not be taken off it
 * first. The domain stays attached and keeps serving the app.
 */
export function publicPathsRefusal(hostname: string, problem: string): string {
  return `The app's public paths could not be taken off ${hostname} in Cloudflare Access (${problem}), so the domain was not removed and still serves the app. Try again in a minute.`;
}
