import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import { z } from "zod";
import { probeHeadersFromEnv } from "../access/probe-credentials.server";
import {
  type AccessUpkeepDeps,
  type AccessUpkeepEnv,
  type AccessUpkeepReport,
  refreshAccessRevisions,
  renewAccessTokens,
  resyncAccessApps,
} from "../access/upkeep-run.server";
import { type CfClientEnv, getCfClient } from "../cloudflare/client.server";
import {
  checkExternalDomains,
  type DomainCheckReport,
} from "../installs/external-domains-poll.server";
import {
  type ExpiredSourceBuilds,
  expireUnusedSourceBuildsCore,
  sandboxBuildCleanup,
} from "../installs/source-builds.server";
import { repairWorkflows, type WorkflowRepairReport } from "../installs/workflow-repair.server";
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
  /**
   * The scheduled upkeep of apps protected with Cloudflare Access, in three
   * parts, each its own call (access/upkeep-run.server.ts).
   */
  refreshAccessRevisions(input: unknown): Promise<NotificationUnitResult<AccessUpkeepReport>>;
  renewAccessTokens(input: unknown): Promise<NotificationUnitResult<AccessUpkeepReport>>;
  resyncAccessApps(input: unknown): Promise<NotificationUnitResult<AccessUpkeepReport>>;
  /** Creates the missing Workflows of installed apps (installs/workflow-repair.server.ts). */
  repairWorkflows(input: unknown): Promise<NotificationUnitResult<WorkflowRepairReport>>;
  /** Throws away builds for review nobody used (installs/source-builds.server.ts). */
  expireSourceBuilds(input: unknown): Promise<NotificationUnitResult<ExpiredSourceBuilds>>;
}

export interface NotificationUnitsEnv extends CfClientEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  /** The catalog caches, for the Access upkeep's revision check. */
  KV?: KVNamespace;
  CATALOG_INDEX_URL?: string;
  /** The sandbox Worker, whose bucket holds builds for review; absent while sandbox builds are off. */
  SANDBOX?: unknown;
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
const accessUpkeepInput = z.object({});
const workflowRepairInput = z.object({});
const sourceBuildExpiryInput = z.object({});

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
  /** One part of the Access upkeep, with this unit's environment and dependencies. */
  const accessPart = (
    part: (env: AccessUpkeepEnv, deps: AccessUpkeepDeps) => Promise<AccessUpkeepReport>,
    input: unknown,
  ) =>
    settle(async () => {
      accessUpkeepInput.parse(input);
      const kv = env.KV;
      if (kv === undefined) throw new Error("the catalog cache is not available");
      const { now, api } = deps;
      return part(
        { ...env, KV: kv },
        {
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(api === undefined ? {} : { client: async () => api }),
          ...(now === undefined ? {} : { now: () => new Date(now()) }),
        },
      );
    });
  return {
    deliverNotifications: (input) =>
      settle(() => {
        const { eventId } = deliverInput.parse(input);
        return deliverDue(env, deps, eventId === undefined ? {} : { eventId });
      }),
    checkInstallsHealth: (input) =>
      settle(() =>
        checkInstallsHealth(env.DB, healthInput.parse(input).installIds, {
          ...deps,
          probeHeaders: probeHeadersFromEnv(
            env,
            deps.fetch === undefined ? {} : { fetch: deps.fetch },
          ),
        }),
      ),
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
    refreshAccessRevisions: (input) => accessPart(refreshAccessRevisions, input),
    renewAccessTokens: (input) => accessPart(renewAccessTokens, input),
    resyncAccessApps: (input) => accessPart(resyncAccessApps, input),
    repairWorkflows: (input) =>
      settle(async () => {
        workflowRepairInput.parse(input);
        const { now } = deps;
        return repairWorkflows({
          db: env.DB,
          api: async () =>
            deps.api ?? getCfClient(env, deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(now === undefined ? {} : { now: () => new Date(now()) }),
        });
      }),
    expireSourceBuilds: (input) =>
      settle(async () => {
        sourceBuildExpiryInput.parse(input);
        const { now } = deps;
        return expireUnusedSourceBuildsCore({
          db: env.DB,
          ...sandboxBuildCleanup(env),
          ...(now === undefined ? {} : { now: () => new Date(now()) }),
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
