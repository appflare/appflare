import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import { artifactManifestSchema } from "@appflare/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import {
  type HealthMode,
  type HealthProbe,
  healthCheckOfManifest,
  isAccessChallenge,
  isEdgeErrorPage,
  probeHealth,
  settleHealthProbe,
} from "../jobs/install/health";
import { varsUseWorkerUrl } from "./install-vars";
import {
  ADDRESS_KINDS,
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
  WILDCARD_DOMAIN_KIND,
} from "./resource-kinds";
import {
  NO_VARS_REFRESH,
  type RefreshVars,
  refreshSettings,
  type VarsRefresh,
} from "./vars-refresh.server";
import {
  domainHostnames,
  primaryDomain,
  type SetWorkersDevInput,
  type WorkersDevKeptReason,
  workersDevSubdomain,
  workersDevWhenDomainLive,
  workersDevWhenDomainRemoved,
} from "./workers-dev";

/**
 * An install's workers.dev URL, server side:
 *
 * - "Serve on workers.dev" on the app page turns it on or off with one
 *   subdomain call and records the admin's choice (`manual`), which every
 *   later deploy sends again. Off is allowed only while one of the install's
 *   domains is live (`domainIsLive`), so the app always keeps an address.
 * - When a custom or external domain first answers as the app, or Cloudflare
 *   Access answers on it (`domainIsLive`; the install job's domain step, or a
 *   check on the app page), `applyDomainLive` records it as live and, while
 *   the choice is `auto`, turns workers.dev off.
 * - Before a domain is removed, `beforeDomainRemoval` turns workers.dev back
 *   on when it was the last live one and the choice is `auto`.
 */

export class WorkersDevError extends Error {
  override name = "WorkersDevError";
}

type WorkersApi = Pick<CloudflareClient, "workers">;

export interface WorkersDevDeps {
  db: D1Database;
  /** The Cloudflare client; called only once the change is allowed. */
  api: () => Promise<WorkersApi>;
  /** The manager's `fetch`, for probing custom domains. */
  fetch: FetchLike;
  now?: () => Date;
  /** Deploys the settings again when they use the app's address; without it nothing is. */
  refreshVars?: RefreshVars;
}

/** At most this many custom domains are probed before turning workers.dev off. */
export const MAX_DOMAIN_PROBES = 3;

/**
 * Whether a probe shows the app itself answering: not an edge error page, not
 * a 5xx, and not Cloudflare Access's sign-in redirect (`isAccessChallenge`),
 * which Access sends before the request reaches the Worker.
 */
export function domainServesApp(probe: HealthProbe, mode: HealthMode): boolean {
  return settleHealthProbe(probe, mode).status === "verified" && !isEdgeErrorPage(probe);
}

/**
 * Whether a probe shows the domain live, as an address of the app: the app
 * answers through it (`domainServesApp`), or Cloudflare Access answers on it
 * with its sign-in redirect. Access answering means HTTPS completed and
 * Cloudflare serves the hostname, and the hostname can only lead to this
 * app: a Workers custom domain belongs to exactly one Worker, and an
 * external domain is probed only once Cloudflare reports it active. Counting
 * it matters: while such a domain is not live, workers.dev stays on, and the
 * app stays reachable there without Access. The install's health still
 * records the Access answer as `unverified`.
 */
export function domainIsLive(probe: HealthProbe, mode: HealthMode): boolean {
  return domainServesApp(probe, mode) || isAccessChallenge(probe);
}

async function activeJobOf(orm: Database, installId: string): Promise<string | null> {
  const [active] = await orm
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.install_id, installId), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  return active?.id ?? null;
}

async function readInstall(orm: Database, installId: string) {
  const [install] = await orm
    .select({
      status: installs.status,
      workerName: installs.worker_name,
      buildKind: installs.build_kind,
      manifestJson: installs.manifest_json,
      configJson: installs.config_json,
      workersDev: installs.workers_dev_enabled,
      choice: installs.workers_dev_choice,
      servedDomain: installs.served_domain,
    })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (install === undefined) throw new WorkersDevError("There is no such install.");
  return install;
}

async function markLive(orm: Database, resourceId: string, at: Date): Promise<void> {
  await orm
    .update(resources)
    .set({ live_at: at })
    .where(
      and(eq(resources.id, resourceId), isNull(resources.live_at), isNull(resources.deleted_at)),
    );
}

/**
 * Records that a request through a custom or external domain reached the
 * app (the first time counts), without touching workers.dev.
 */
export async function recordDomainLive(
  db: D1Database,
  resourceId: string,
  now?: () => Date,
): Promise<void> {
  await markLive(createDb(db), resourceId, (now ?? (() => new Date()))());
}

export interface SetWorkersDevResult extends VarsRefresh {
  enabled: boolean;
  /** The custom domain that answered, when workers.dev was turned off. */
  servedBy: string | null;
}

export async function setWorkersDevCore(
  deps: WorkersDevDeps,
  input: SetWorkersDevInput,
): Promise<SetWorkersDevResult> {
  const orm = createDb(deps.db);
  const install = await readInstall(orm, input.installId);
  if (install.buildKind === "self-deploying") {
    throw new WorkersDevError(
      "The app's own installer decides whether its Worker answers on workers.dev.",
    );
  }
  // A job reads the stored value when it starts; changing it under one would
  // leave the Worker and the record apart.
  if (install.status !== "installed" || (await activeJobOf(orm, input.installId)) !== null) {
    throw new WorkersDevError(
      "A job of this app is running, or it is not installed. Wait for it to finish.",
    );
  }
  if (install.workersDev === input.enabled) {
    return { enabled: input.enabled, servedBy: null, ...NO_VARS_REFRESH };
  }

  let served: { id: string; name: string } | null = null;
  if (!input.enabled) {
    const rows = await orm
      .select({
        id: resources.id,
        kind: resources.kind,
        name: resources.name,
        live_at: resources.live_at,
      })
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
      if (domainIsLive(probe, check.mode)) {
        served = rows.find((r) => r.name === hostname) ?? null;
        break;
      }
      tried.push(hostname);
    }
    if (served === null) {
      throw new WorkersDevError(
        `None of this app's domains answered as the app (${tried.join(", ")}), so turning off workers.dev would leave it without an address. Check the domains, then try again.`,
      );
    }
  }

  const api = await deps.api();
  await api.workers.enableSubdomain(install.workerName, workersDevSubdomain(input.enabled));
  await orm
    .update(installs)
    .set({
      workers_dev_enabled: input.enabled,
      served_domain: served?.name ?? null,
      // From now on the admin decides, and a domain going live changes nothing.
      workers_dev_choice: "manual",
    })
    .where(eq(installs.id, input.installId));
  if (served !== null) await markLive(orm, served.id, (deps.now ?? (() => new Date()))());
  // The app's address moved between workers.dev and a domain.
  const refresh = await refreshSettings(deps.refreshVars, input.installId, ["appUrl"]);
  return { enabled: input.enabled, servedBy: served?.name ?? null, ...refresh };
}

const configSchema = z.record(z.string(), z.string());

/**
 * Whether the Worker's vars were filled in with its workers.dev address
 * (`{{workerUrl}}`, `{{workerHostname}}`), read from the install's recorded
 * manifest and settings. False when the manifest cannot be read (then there
 * is nothing to go by). Settings that use the app's address (`{{appUrl}}`)
 * do not count: they are deployed again with the domain.
 */
export function settingsUseWorkerUrl(manifestJson: string | null, configJson: string | null) {
  if (manifestJson === null) return false;
  try {
    const manifest = artifactManifestSchema.safeParse(JSON.parse(manifestJson));
    if (!manifest.success) return false;
    const vars = configSchema.safeParse(configJson === null ? {} : JSON.parse(configJson));
    return varsUseWorkerUrl(manifest.data, vars.success ? vars.data : {});
  } catch {
    return false;
  }
}

export interface DomainLiveRequest {
  installId: string;
  /** The domain's `resources` row. */
  resourceId: string;
  hostname: string;
  /**
   * Set by the install's own job, which holds the install while it runs and
   * knows what the Worker's vars were filled in with.
   */
  job?: { settingsUseWorkerUrl: boolean };
}

export interface DomainLiveResult extends VarsRefresh {
  /** This call turned workers.dev off. */
  turnedOff: boolean;
  /** Why workers.dev was left as it was; null when this call turned it off. */
  kept: WorkersDevKeptReason | null;
}

/**
 * A custom or external domain of the install answered as the app, or
 * Cloudflare Access answered on it (`domainIsLive`): records it as live, and turns workers.dev off when `workersDevWhenDomainLive` says so,
 * with one subdomain call (version previews stay on, so update checks keep
 * working) and the domain recorded as the one that serves the app. Outside
 * the install job it changes nothing while a job of the app runs (that job
 * sends the stored value when it deploys); the next check tries again. Once
 * workers.dev is off, settings that use the app's address (`{{appUrl}}`)
 * are deployed again with the domain (`refreshVars`; the install job does
 * that itself once it is recorded).
 */
export async function applyDomainLive(
  deps: {
    db: D1Database;
    api: () => Promise<WorkersApi>;
    now?: () => Date;
    refreshVars?: RefreshVars;
  },
  request: DomainLiveRequest,
): Promise<DomainLiveResult> {
  const orm = createDb(deps.db);
  await markLive(orm, request.resourceId, (deps.now ?? (() => new Date()))());
  const install = await readInstall(orm, request.installId);
  const outcome = workersDevWhenDomainLive({
    choice: install.choice,
    enabled: install.workersDev,
    selfDeploying: install.buildKind === "self-deploying",
    settingsUseWorkersDevUrl:
      request.job?.settingsUseWorkerUrl ??
      settingsUseWorkerUrl(install.manifestJson, install.configJson),
  });
  if (outcome.action === "keep") {
    return { turnedOff: false, kept: outcome.reason, ...NO_VARS_REFRESH };
  }
  if (
    request.job === undefined &&
    (install.status !== "installed" || (await activeJobOf(orm, request.installId)) !== null)
  ) {
    return { turnedOff: false, kept: "busy", ...NO_VARS_REFRESH };
  }
  const api = await deps.api();
  await api.workers.enableSubdomain(install.workerName, workersDevSubdomain(false));
  await orm
    .update(installs)
    .set({ workers_dev_enabled: false, served_domain: request.hostname })
    .where(eq(installs.id, request.installId));
  const refresh =
    request.job === undefined
      ? await refreshSettings(deps.refreshVars, request.installId, ["appUrl"])
      : NO_VARS_REFRESH;
  return { turnedOff: true, kept: null, ...refresh };
}

/**
 * The live domain that takes over as the served one: the first custom
 * domain, else the first wildcard domain's base, else the first external
 * domain (oldest first, as `appAddress` picks); null with none.
 */
export function nextServedDomain(
  live: readonly { id: string; kind: string; name: string }[],
): string | null {
  const byId = [...live].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return (
    byId.find((d) => d.kind === CUSTOM_DOMAIN_KIND)?.name ??
    byId.find((d) => d.kind === WILDCARD_DOMAIN_KIND)?.name ??
    byId.find((d) => d.kind === CUSTOM_HOSTNAME_KIND)?.name ??
    null
  );
}

/**
 * Before a custom or external domain is removed: when it is the install's
 * last live domain and workers.dev is off, turns workers.dev back on (choice
 * `auto`, one subdomain call) or refuses (choice `manual`), so the app never
 * loses its last address. Refuses too while a job of the app runs, since
 * that job would send workers.dev's old value when it deploys. When it is
 * the served domain and another live one remains, that one becomes served.
 * `addressChanged` says the app's address moved (to workers.dev or to
 * another domain), so the caller deploys settings that use `{{appUrl}}`
 * again once the domain is gone.
 */
export async function beforeDomainRemoval(
  deps: { db: D1Database; api: () => Promise<WorkersApi> },
  request: { installId: string; resourceId: string },
): Promise<{ turnedOn: boolean; addressChanged: boolean }> {
  const orm = createDb(deps.db);
  const install = await readInstall(orm, request.installId);
  const [removed] = await orm
    .select({ name: resources.name })
    .from(resources)
    .where(eq(resources.id, request.resourceId))
    .limit(1);
  const domains = await orm
    .select({
      id: resources.id,
      kind: resources.kind,
      name: resources.name,
      live_at: resources.live_at,
    })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, request.installId),
        inArray(resources.kind, [...ADDRESS_KINDS]),
        isNull(resources.deleted_at),
      ),
    );
  const others = domains.filter((d) => d.live_at !== null && d.id !== request.resourceId);
  const outcome = workersDevWhenDomainRemoved({
    choice: install.choice,
    enabled: install.workersDev,
    otherLiveDomains: others.length,
  });
  if (outcome.action === "refuse") throw new WorkersDevError(outcome.message);
  if (outcome.action === "keep") {
    // Health checks, canaries and `{{appUrl}}` follow the served domain:
    // it moves to another live domain rather than stay on one being removed.
    if (removed !== undefined && install.servedDomain === removed.name) {
      await orm
        .update(installs)
        .set({ served_domain: nextServedDomain(others) })
        .where(eq(installs.id, request.installId));
    }
    // With workers.dev on, the app is served there whichever domain goes;
    // with it off, the address moves only when this domain was the one.
    const servedBefore = install.workersDev
      ? null
      : primaryDomain(domainHostnames(domains), install.servedDomain);
    return {
      turnedOn: false,
      addressChanged: removed !== undefined && servedBefore === removed.name,
    };
  }
  if ((await activeJobOf(orm, request.installId)) !== null) {
    throw new WorkersDevError(
      "This is the app's only address while its workers.dev URL is off, and a job of the app is running. Wait for it to finish, then remove the domain; workers.dev is turned back on first.",
    );
  }
  const api = await deps.api();
  await api.workers.enableSubdomain(install.workerName, workersDevSubdomain(true));
  await orm
    .update(installs)
    .set({ workers_dev_enabled: true, served_domain: null })
    .where(eq(installs.id, request.installId));
  return { turnedOn: true, addressChanged: true };
}
