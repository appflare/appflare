import type { FetchLike } from "@appflare/cf-api";
import { checkInstallHealthCore, HealthCheckError } from "../installs/health.server";

/**
 * The scheduled health check behind "Health check failing": the same single
 * probe as "Check now" on an app's page, recorded the same way, for a batch
 * of installed apps. A server error is probed once more after a short wait;
 * only two server errors in a row, both from this check, can start a
 * failing episode (events.server.ts), so one bad request, a "Check now" or a
 * job's health check never does on its own. Runs only while some channel wants the event, as the
 * `checkInstallsHealth` job unit, in its own invocation. Per install: at
 * most two probes and six D1 calls, so `HEALTH_CHECKS_PER_CALL` installs stay
 * under 50 subrequests even if D1 calls counted toward the limit.
 */

export const HEALTH_CHECKS_PER_CALL = 5;
export const HEALTH_RECHECK_MS = 5_000;

export interface HealthSweepDeps {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface HealthSweepReport {
  checked: number;
  unhealthy: number;
  /** Installs whose two probes in this call both got a server error, recorded as `unhealthy`. */
  unhealthyIds: string[];
}

/** Installed apps to probe, least recently checked first. */
export async function installsToCheck(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT id FROM installs WHERE status = 'installed'
       ORDER BY coalesce(health_checked_at, 0), id LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function checkInstallsHealth(
  db: D1Database,
  installIds: readonly string[],
  deps: HealthSweepDeps = {},
): Promise<HealthSweepReport> {
  const fetchFn: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const check = { db, fetch: fetchFn, ...(deps.now === undefined ? {} : { now: deps.now }) };
  const report: HealthSweepReport = { checked: 0, unhealthy: 0, unhealthyIds: [] };
  await Promise.all(
    installIds.slice(0, HEALTH_CHECKS_PER_CALL).map(async (installId) => {
      try {
        const first = await checkInstallHealthCore(check, { installId });
        let confirmed = false;
        if (first.status === "unhealthy") {
          await sleep(HEALTH_RECHECK_MS);
          const second = await checkInstallHealthCore(check, { installId });
          confirmed = second.status === "unhealthy" && second.recorded;
        }
        report.checked++;
        if (confirmed) {
          report.unhealthy++;
          report.unhealthyIds.push(installId);
        }
      } catch (error) {
        // Not installed any more, or the account's subdomain is not known: nothing to check.
        if (!(error instanceof HealthCheckError)) throw error;
      }
    }),
  );
  return report;
}
