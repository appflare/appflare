import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import { z } from "zod";
import { type CfClientEnv, getCfClient } from "../cloudflare/client.server";
import {
  checkExternalDomains,
  type DomainCheckReport,
} from "../installs/external-domains-poll.server";
import { type DeliveryReport, deliverDue } from "./deliver.server";
import {
  checkInstallsHealth,
  HEALTH_CHECKS_PER_CALL,
  type HealthSweepReport,
} from "./health-sweep.server";

/**
 * The notification units, served by the manager's `JobUnits` entrypoint next
 * to the job units and reached the same way: over the `SELF` service
 * binding, so each call runs in a fresh invocation with its own subrequest
 * limit and costs the caller (a job, or the cron) one subrequest. Inputs are
 * validated here; credentials are read by the unit from D1 and decrypted with
 * the Worker's own secret, never passed in. Results are plain data and a
 * unit never throws, so an RPC failure is the only error a caller sees.
 */

export type NotificationUnitResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface NotificationUnitsApi {
  deliverNotifications(input: unknown): Promise<NotificationUnitResult<DeliveryReport>>;
  checkInstallsHealth(input: unknown): Promise<NotificationUnitResult<HealthSweepReport>>;
  /** The scheduled check of external domains (installs/external-domains-poll.server.ts). */
  checkExternalDomains(input: unknown): Promise<NotificationUnitResult<DomainCheckReport>>;
}

export interface NotificationUnitsEnv extends CfClientEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
}

export interface NotificationUnitsDeps {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The Cloudflare client of the domain check; built from the Worker's own token by default. */
  api?: CloudflareClient;
}

const deliverInput = z.object({ eventId: z.string().min(1).max(64).optional() });
const healthInput = z.object({
  installIds: z.array(z.string().min(1).max(64)).max(HEALTH_CHECKS_PER_CALL),
});
const domainsInput = z.object({});

async function settle<T>(run: () => Promise<T>): Promise<NotificationUnitResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createNotificationUnits(
  env: NotificationUnitsEnv,
  deps: NotificationUnitsDeps = {},
): NotificationUnitsApi {
  return {
    deliverNotifications: (input) =>
      settle(() => {
        const { eventId } = deliverInput.parse(input);
        return deliverDue(env, deps, eventId === undefined ? {} : { eventId });
      }),
    checkInstallsHealth: (input) =>
      settle(() => checkInstallsHealth(env.DB, healthInput.parse(input).installIds, deps)),
    checkExternalDomains: (input) =>
      settle(async () => {
        domainsInput.parse(input);
        return checkExternalDomains({
          db: env.DB,
          api:
            deps.api ??
            (() => getCfClient(env, deps.fetch === undefined ? {} : { fetch: deps.fetch })),
          ...(deps.now === undefined ? {} : { now: deps.now }),
        });
      }),
  };
}

/**
 * The notification units over `SELF`, or undefined on a manager deployed
 * without the binding (callers then run them in place, or leave the work to
 * the next scheduled run). The binding's generated type knows only the job
 * units; `JobUnits` serves these too.
 */
export function selfNotificationUnits(env: { SELF?: unknown }): NotificationUnitsApi | undefined {
  const self: unknown = env.SELF;
  return self === undefined || self === null ? undefined : (self as NotificationUnitsApi);
}
