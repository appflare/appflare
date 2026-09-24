import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import {
  type HealthMode,
  type HealthProbe,
  healthCheckOfManifest,
  isEdgeErrorPage,
  probeHealth,
  settleHealthProbe,
} from "../jobs/install/health";
import { ADDRESS_KINDS } from "./resource-kinds";
import { domainHostnames, type SetWorkersDevInput, workersDevSubdomain } from "./workers-dev";

/**
 * "Serve on workers.dev" on the app page: turns an install's workers.dev URL
 * on or off with one subdomain call and records the choice, which every
 * later deploy sends again. Off is allowed only while one of the install's
 * custom domains answers as the app, so the app always keeps an address.
 */

export class WorkersDevError extends Error {
  override name = "WorkersDevError";
}

export interface WorkersDevDeps {
  db: D1Database;
  /** The Cloudflare client; called only once the change is allowed. */
  api: () => Promise<Pick<CloudflareClient, "workers">>;
  /** The manager's `fetch`, for probing custom domains. */
  fetch: FetchLike;
}

/** At most this many custom domains are probed before turning workers.dev off. */
export const MAX_DOMAIN_PROBES = 3;

/** Whether a probe shows the app itself answering (not an edge error page, not a 5xx). */
export function domainServesApp(probe: HealthProbe, mode: HealthMode): boolean {
  return settleHealthProbe(probe, mode).status === "verified" && !isEdgeErrorPage(probe);
}

export interface SetWorkersDevResult {
  enabled: boolean;
  /** The custom domain that answered, when workers.dev was turned off. */
  servedBy: string | null;
}

export async function setWorkersDevCore(
  deps: WorkersDevDeps,
  input: SetWorkersDevInput,
): Promise<SetWorkersDevResult> {
  const orm = createDb(deps.db);
  const [install] = await orm
    .select({
      status: installs.status,
      workerName: installs.worker_name,
      buildKind: installs.build_kind,
      manifestJson: installs.manifest_json,
      workersDev: installs.workers_dev_enabled,
    })
    .from(installs)
    .where(eq(installs.id, input.installId))
    .limit(1);
  if (install === undefined) throw new WorkersDevError("There is no such install.");
  if (install.buildKind === "self-deploying") {
    throw new WorkersDevError(
      "The app's own installer decides whether its Worker answers on workers.dev.",
    );
  }
  // A job reads the stored value when it starts; changing it under one would
  // leave the Worker and the record apart.
  const [active] = await orm
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.install_id, input.installId), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  if (install.status !== "installed" || active !== undefined) {
    throw new WorkersDevError(
      "A job of this app is running, or it is not installed. Wait for it to finish.",
    );
  }
  if (install.workersDev === input.enabled) return { enabled: input.enabled, servedBy: null };

  let servedBy: string | null = null;
  if (!input.enabled) {
    const rows = await orm
      .select({ id: resources.id, kind: resources.kind, name: resources.name })
      .from(resources)
      .where(
        and(
          eq(resources.install_id, input.installId),
          inArray(resources.kind, [...ADDRESS_KINDS]),
          isNull(resources.deleted_at),
        ),
      );
    const hostnames = domainHostnames(rows);
    if (hostnames.length === 0) {
      throw new WorkersDevError(
        "This app has no custom or external domain, so workers.dev is its only address. Add one first.",
      );
    }
    const check = healthCheckOfManifest(install.manifestJson);
    const tried: string[] = [];
    for (const hostname of hostnames.slice(0, MAX_DOMAIN_PROBES)) {
      const probe = await probeHealth(deps.fetch, `https://${hostname}${check.path}`);
      if (domainServesApp(probe, check.mode)) {
        servedBy = hostname;
        break;
      }
      tried.push(hostname);
    }
    if (servedBy === null) {
      throw new WorkersDevError(
        `None of this app's domains answered as the app (${tried.join(", ")}), so turning off workers.dev would leave it without an address. Check the domains, then try again.`,
      );
    }
  }

  const api = await deps.api();
  await api.workers.enableSubdomain(install.workerName, workersDevSubdomain(input.enabled));
  await orm
    .update(installs)
    .set({ workers_dev_enabled: input.enabled, served_domain: servedBy })
    .where(eq(installs.id, input.installId));
  return { enabled: input.enabled, servedBy };
}

/**
 * Why removing a custom domain would leave the app without an address (its
 * workers.dev URL is off and no other custom domain is recorded), or null.
 */
export function lastAddressRefusal(workersDev: boolean, otherDomains: number): string | null {
  if (workersDev || otherDomains > 0) return null;
  return "This is the app's only address: its workers.dev URL is off. Turn on Serve on workers.dev first, or add another domain.";
}
