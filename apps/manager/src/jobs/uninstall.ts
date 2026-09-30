import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError } from "@appflare/cf-api";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { removeInstallAccess } from "../access/install-access.server";
import { withAccessLock } from "../access/toggle.server";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import {
  isGatewayReady,
  readGateway,
  SSL_PERMISSION,
  saasRefusal,
  unbindGatewayService,
} from "../gateway/gateway.server";
import {
  type DetachOutcome,
  detachCustomDomain,
  detachMessage,
  isPermissionError,
} from "../installs/custom-domains.server";
import { detachExternalDomain, externalDetachMessage } from "../installs/external-domains.server";
import { namesHeldElsewhere } from "../installs/removed-apps.server";
import {
  ACCESS_SERVICE_TOKEN_KIND,
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
  DATA_RESOURCE_KINDS,
  type DataResourceKind,
  EMAIL_ROUTE_KIND,
  HYPERDRIVE_KINDS,
  PIPELINE_KINDS,
  R2_CATALOG_KIND,
  WILDCARD_DOMAIN_KIND,
  WILDCARD_PARTS_KINDS,
  WORKER_BOUND_KINDS,
} from "../installs/resource-kinds";
import { detachWildcardParts, wildcardDetachMessage } from "../installs/wildcard-domains.server";
import { sandboxBuildOfInput } from "../sandbox/progress";
import { cleanupSandboxBuildsPhase } from "./install/artifact-source";
import { type EmailRouteRecord, removeEmailRoutesPhase } from "./install/email-routing";
import { deleteOtherWorkersPhase } from "./install/entry-worker-phases";
import {
  deletePipelineObject,
  type PipelineTarget,
  pipelineObjectLabel,
  pipelineTargets,
  removeBucketCatalog,
} from "./install/pipelines";
import { consumerTargets, removeQueueConsumersPhase } from "./install/queue-consumers";
import { deleteResource, RESOURCE_LABEL } from "./install/resources";
import type { JobContext } from "./run-job";
import { runSelfDeployingUninstall } from "./self-deploying/jobs";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, isNotFound, JobError, type JobSteps } from "./steps";
import { settleUnit } from "./units/result";
import { R2_PAGE_MAX_OBJECTS } from "./units/units";

/**
 * The `uninstall` job. One API call per step, retried on 429/5xx like the
 * install; a 404 means the object is already gone and counts as deleted, so a
 * retried or repeated uninstall converges. Order: what the install set up in
 * Email Routing first (its routing rules, the catch-all, then Email Routing
 * itself if Appflare turned it on and nothing else uses it; mail must not go
 * to a deleted Worker), then its external domains (each custom hostname and
 * its routing entry, then the gateway's binding to the Worker, so the
 * gateway never binds a deleted Worker), then the install's custom domains
 * (always; they hold no data, and Cloudflare does not document that deleting
 * a Worker removes them, so they get calls of their own), then its wildcard
 * domain (its Workers routes, then its DNS records, which are zone objects
 * that outlive the Worker), then its queue
 * consumers (no data
 * either; each is removed before the Worker it points at and before the queue
 * it reads), then the Worker (with `?force=true`, which also removes its cron
 * triggers, workers.dev route, secrets, and Durable Objects), then each of its
 * Workflows by name (deleting a Worker leaves the Workflows it ran, with
 * their instances), then its Hyperdrive configurations, the bound ones and
 * those a settings change replaced (always: they hold a database's
 * credentials, never its data, which stays in the admin's database), then
 * each ticked data resource.
 * The Worker is deleted only when this install recorded it: an install that
 * failed before its upload never owned a Worker of that name, and the account
 * may hold someone else's. An R2 bucket must be empty before it can be
 * deleted, so its objects are listed and deleted first, a page per step,
 * each page one job unit (`emptyR2Page`).
 * Resources the admin kept were marked retained when the uninstall started
 * and are never touched. An install built in the sandbox Worker has its
 * builds deleted from the sandbox Worker's bucket last (housekeeping that
 * never fails the job).
 *
 * On failure the job records `<step>: <message>` and the install stays
 * `uninstalling`, so the install page offers a retry for what is left.
 */

/** The Workflow payload `startUninstall` creates. */
export const uninstallJobParams = z.object({
  kind: z.literal("uninstall"),
  jobId: z.string().min(1),
  installId: z.string().min(1),
  /** Ids of the data resources to delete. */
  deleteResources: z.array(z.string().min(1)).max(500),
  /**
   * A self-deploying tier app: its own installer's destroy command removes
   * everything (see ./self-deploying/jobs.ts); `deleteResources` does not apply.
   */
  selfDeploying: z.boolean().optional(),
  /**
   * Deletes data an earlier uninstall kept (the install stays `uninstalled`):
   * only the data resource steps run, for the retained resources in
   * `deleteResources`.
   */
  deleteRetained: z.boolean().optional(),
});
export type UninstallJobParams = z.infer<typeof uninstallJobParams>;

/**
 * R2 objects deleted per step: one job unit lists a page and deletes each
 * object on it (one subrequest per object, plus the list call). Over `SELF`
 * the unit has an invocation of its own, so a page can be as large as a unit
 * allows.
 */
export const R2_OBJECTS_PER_STEP = R2_PAGE_MAX_OBJECTS;

/**
 * R2 objects per page when the unit runs in the job's own invocation (a
 * manager without the `SELF` binding): 31 subrequests, what a page always
 * cost there, leaving the rest of the 50 to the job's other steps.
 */
export const R2_OBJECTS_PER_LOCAL_STEP = 30;

/**
 * Pages of R2 objects one run deletes, across all buckets, before it stops
 * and asks for a retry, which continues where it stopped. Every page is one
 * call from the job's own invocation, whose subrequest limit (50 on Workers
 * Free) the whole run shares, so a run stays well inside it (see
 * units/client.ts). Without the `SELF` binding the page itself runs in the
 * job's own invocation, so a run deletes one page
 * ({@link R2_MAX_LOCAL_PAGES_PER_RUN}).
 */
export const R2_MAX_PAGES_PER_RUN = 20;

/** Pages one run deletes without the `SELF` binding. */
export const R2_MAX_LOCAL_PAGES_PER_RUN = 1;

interface Target {
  id: string;
  kind: DataResourceKind;
  name: string;
  cfId: string | null;
  /**
   * For an R2 bucket a Pipelines sink wrote to: the `resources` id of its
   * Data Catalog, removed before the bucket is emptied. Absent in a run
   * started before catalogs were recorded.
   */
  catalogId?: string;
}

/**
 * The data targets with each bucket's Data Catalog attached (the recorded
 * `r2_catalog` row of the same name), so it goes with its bucket.
 */
function withCatalogs(
  targets: readonly Target[],
  catalogs: ReadonlyArray<{ id: string; name: string }>,
): Target[] {
  return targets.map((t) => {
    if (t.kind !== "r2") return t;
    const catalog = catalogs.find((c) => c.name === t.name);
    return catalog === undefined ? t : { ...t, catalogId: catalog.id };
  });
}

/** A recorded Workflow of the app's Worker, deleted by name after the Worker. */
interface WorkflowTarget {
  id: string;
  name: string;
}

/** A recorded Hyperdrive configuration, deleted by id after the Worker. */
interface HyperdriveTarget {
  id: string;
  name: string;
  cfId: string | null;
}

/** A recorded custom domain: `name` is the hostname, `cfId` the domain's id. */
interface DomainTarget {
  id: string;
  hostname: string;
  cfId: string | null;
}

/**
 * A recorded wildcard domain (`hostname` is its base) with its records and
 * routes; `id` is null for records and routes whose wildcard domain row is
 * gone (removed together, so only a hand-edited database has them).
 */
interface WildcardTarget {
  id: string | null;
  hostname: string;
  parts: Array<{ id: string; kind: string; name: string; cfId: string | null }>;
}

/** A recorded external domain: `cfId` is `<zone id>/<custom hostname id>`. */
interface ExternalDomainTarget {
  id: string;
  hostname: string;
  cfId: string | null;
  binding: string | null;
  /** When the install claimed the name (epoch ms). */
  claimedAt: number;
}

export async function runUninstall(ctx: JobContext): Promise<void> {
  const parsed = uninstallJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid uninstall job payload");
  const params = parsed.data;
  if (params.selfDeploying === true) {
    await runSelfDeployingUninstall(ctx, params);
    return;
  }
  if (params.deleteRetained === true) {
    await runDeleteRetained(ctx, params);
    return;
  }
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;

  try {
    const started = await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      const [install] = await orm
        .select({ workerName: installs.worker_name, buildKind: installs.build_kind })
        .from(installs)
        .where(eq(installs.id, params.installId))
        .limit(1);
      if (install === undefined) throw new JobError("the install no longer exists");
      const live = await orm
        .select()
        .from(resources)
        .where(and(eq(resources.install_id, params.installId), isNull(resources.deleted_at)))
        .orderBy(sql`rowid`);
      const wanted = new Set(params.deleteResources);
      const targets: Target[] = [];
      for (const r of live) {
        if (r.retained_at !== null || !wanted.has(r.id)) continue;
        // Resources an app's own installer created (self-deploying tier) are
        // removed by that installer; Appflare never deletes them itself.
        if (r.managed_by === "app") continue;
        const kind = DATA_RESOURCE_KINDS.find((k) => k === r.kind);
        if (kind !== undefined) targets.push({ id: r.id, kind, name: r.name, cfId: r.cf_id });
      }
      // Custom domains are never kept: they hold no data.
      const domains: DomainTarget[] = live
        .filter((r) => r.kind === CUSTOM_DOMAIN_KIND)
        .map((r) => ({ id: r.id, hostname: r.name, cfId: r.cf_id }));
      // Nor are wildcard domains, with their records and routes.
      const wildcardParts = live.filter((r) =>
        (WILDCARD_PARTS_KINDS as readonly string[]).includes(r.kind),
      );
      const wildcardDomains: WildcardTarget[] = live
        .filter((r) => r.kind === WILDCARD_DOMAIN_KIND)
        .map((r) => ({ id: r.id, hostname: r.name, parts: [] }));
      for (const part of wildcardParts) {
        const base = part.binding ?? part.name;
        let target = wildcardDomains.find((d) => d.hostname === base);
        if (target === undefined) {
          target = { id: null, hostname: base, parts: [] };
          wildcardDomains.push(target);
        }
        target.parts.push({ id: part.id, kind: part.kind, name: part.name, cfId: part.cf_id });
      }
      // Nor are external domains. The gateway's bindings to the Worker are
      // read from every external domain the install ever had, so a run that
      // removed the domains but not the binding removes it when retried.
      const externalDomains: ExternalDomainTarget[] = live
        .filter((r) => r.kind === CUSTOM_HOSTNAME_KIND)
        .map((r) => ({
          id: r.id,
          hostname: r.name,
          cfId: r.cf_id,
          binding: r.binding,
          claimedAt: r.created_at.getTime(),
        }));
      const gatewayBindings = [
        ...new Set(
          (
            await orm
              .select({ binding: resources.binding })
              .from(resources)
              .where(
                and(
                  eq(resources.install_id, params.installId),
                  eq(resources.kind, CUSTOM_HOSTNAME_KIND),
                ),
              )
          ).flatMap((r) => (r.binding === null ? [] : [r.binding])),
        ),
      ];
      // Cloudflare Access protection goes too: the app's Access application
      // and its own service token, which hold no data.
      const accessProtected = live.some((r) => r.kind === ACCESS_SERVICE_TOKEN_KIND);
      // Email routes are never kept either: mail to a deleted Worker bounces.
      const emailRoutes: EmailRouteRecord[] = live
        .filter((r) => r.kind === EMAIL_ROUTE_KIND)
        .map((r) => ({ id: r.id, name: r.name, cfId: r.cf_id }));
      // Queue consumers are never kept either; they go before the Worker and
      // before any queue they read.
      const consumers = consumerTargets(
        params.installId,
        live.map((r) => ({ id: r.id, kind: r.kind, name: r.name, cfId: r.cf_id })),
      );
      // Workflows go after the Worker, by name: Cloudflare keeps a Workflow
      // (and its instances) when the Worker that runs it is deleted. Those an
      // app's own installer created are removed by that installer.
      const workflows: WorkflowTarget[] = live
        .filter((r) => r.kind === "workflow" && r.managed_by !== "app")
        .map((r) => ({ id: r.id, name: r.name }));
      // Hyperdrive configurations are never kept: they hold the database's
      // credentials, not its data. They go after the Worker that binds them.
      const hyperdrive: HyperdriveTarget[] = live
        .filter(
          (r) => (HYPERDRIVE_KINDS as readonly string[]).includes(r.kind) && r.managed_by !== "app",
        )
        .map((r) => ({ id: r.id, name: r.name, cfId: r.cf_id }));
      // Pipelines streams, sinks and pipelines are never kept: they hold no
      // data (the sink holds the admin's token). They go after the Worker
      // that sends to the stream, pipeline first.
      const pipelines: PipelineTarget[] = pipelineTargets(
        live
          .filter(
            (r) => (PIPELINE_KINDS as readonly string[]).includes(r.kind) && r.managed_by !== "app",
          )
          .map((r) => ({ id: r.id, kind: r.kind, name: r.name, cfId: r.cf_id })),
      );
      // A bucket's Data Catalog goes with the bucket: removed when the bucket
      // is deleted, kept (and listed as kept) when the bucket is.
      const catalogs = live.filter((r) => r.kind === R2_CATALOG_KIND && r.managed_by !== "app");
      for (const catalog of catalogs) {
        const bucket = live.find(
          (r) => r.kind === "r2" && r.name === catalog.name && r.retained_at !== null,
        );
        if (bucket === undefined || catalog.retained_at !== null) continue;
        await orm
          .update(resources)
          .set({ retained_at: bucket.retained_at })
          .where(eq(resources.id, catalog.id));
        catalog.retained_at = bucket.retained_at;
      }
      const dataTargets = withCatalogs(
        targets,
        catalogs.filter((c) => c.retained_at === null),
      );
      const kept = live
        .filter((r) => r.retained_at !== null && r.kind !== R2_CATALOG_KIND)
        .map((r) => r.name);
      // "live": recorded and not deleted yet; "deleted": an earlier run deleted
      // it; "none": this install never recorded a Worker.
      let worker: "live" | "deleted" | "none" = "none";
      if (live.some((r) => r.kind === "worker")) worker = "live";
      else {
        const [anyWorker] = await orm
          .select({ id: resources.id })
          .from(resources)
          .where(and(eq(resources.install_id, params.installId), eq(resources.kind, "worker")))
          .limit(1);
        if (anyWorker !== undefined) worker = "deleted";
      }
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      log.info(
        `Uninstalling Worker "${install.workerName}". ` +
          (accessProtected ? "Removing its Cloudflare Access protection. " : "") +
          (emailRoutes.length > 0
            ? `Removing email routes: ${emailRoutes.map((r) => r.name).join(", ")}. `
            : "") +
          (domains.length > 0
            ? `Removing custom domains: ${domains.map((d) => d.hostname).join(", ")}. `
            : "") +
          (externalDomains.length > 0
            ? `Removing external domains: ${externalDomains.map((d) => d.hostname).join(", ")}. `
            : "") +
          (wildcardDomains.length > 0
            ? `Removing wildcard domains: ${wildcardDomains.map((d) => `*.${d.hostname}`).join(", ")}. `
            : "") +
          (hyperdrive.length > 0
            ? `Removing Hyperdrive configurations: ${hyperdrive.map((h) => h.name).join(", ")} (the databases stay as they are). `
            : "") +
          (pipelines.length > 0
            ? `Removing Pipelines: ${pipelines.map((p) => p.name).join(", ")}. `
            : "") +
          (targets.length > 0
            ? `Deleting: ${dataTargets.map((t) => `${RESOURCE_LABEL[t.kind]} ${t.name}${t.catalogId === undefined ? "" : " with its R2 Data Catalog"}`).join(", ")}. `
            : "No data resources to delete. ") +
          (kept.length > 0 ? `Keeping: ${kept.join(", ")}.` : "Keeping nothing."),
      );
      return {
        workerName: install.workerName,
        // An app of several Workers: its other Workers, deleted before the primary one.
        otherWorkers: live
          .filter((r) => r.kind === "worker" && r.name !== install.workerName)
          .map((r) => ({ id: r.id, name: r.name })),
        accountId: settings.account_id,
        targets: dataTargets,
        pipelines,
        domains,
        wildcardDomains,
        externalDomains,
        gatewayBindings,
        consumers,
        emailRoutes,
        accessProtected,
        workflows,
        hyperdrive,
        kept,
        worker,
        // An install made before builds were recorded is a signed release.
        // A sandbox build may exist even when the install never recorded one:
        // an install or update that failed after its build keeps the old
        // provenance. Any job of the install that asked for a build counts.
        sandboxBuilt:
          install.buildKind === "sandbox" ||
          (
            await orm
              .select({ input: jobs.input_json })
              .from(jobs)
              .where(eq(jobs.install_id, params.installId))
          ).some((job) => sandboxBuildOfInput(job.input) !== null),
      };
    });
    steps.setAccountId(started.accountId);
    const { workerName } = started;

    // A job started before email routes existed carries no list.
    await removeEmailRoutesPhase(steps, started.emailRoutes ?? [], workerName);

    // A run started before external domains existed carries none.
    for (const domain of started.externalDomains ?? []) {
      await run(`remove external domain ${domain.hostname}`, async ({ log, cf, orm }) => {
        try {
          const outcome = await detachExternalDomain(cf(), await readGateway(orm), {
            hostname: domain.hostname,
            cfId: domain.cfId,
            // A run started before these were recorded removes the routing entry as before.
            binding: domain.binding ?? null,
            claimedAt: domain.claimedAt ?? 0,
          });
          log.info(externalDetachMessage(domain.hostname, outcome));
        } catch (error) {
          if (saasRefusal(error) !== "missing-permission") throw error;
          throw new JobError(
            `Cloudflare refused to remove the external domain ${domain.hostname} (${errorMessage(error)}). The token needs ${SSL_PERMISSION} on the gateway domain; add it to the token and retry the uninstall`,
          );
        }
        await orm
          .update(resources)
          .set({ deleted_at: new Date(now()) })
          .where(eq(resources.id, domain.id));
        return {};
      });
    }
    for (const binding of started.gatewayBindings ?? []) {
      await run(`remove gateway binding ${binding}`, async ({ log, cf, orm }) => {
        const gateway = await readGateway(orm);
        if (!isGatewayReady(gateway)) {
          log.info("The external domains gateway is gone, and its bindings with it.");
          return {};
        }
        const outcome = await unbindGatewayService(cf(), gateway, binding);
        log.info(
          outcome === "unchanged"
            ? `The gateway no longer reaches "${workerName}".`
            : `Removed the gateway's binding ${binding} to "${workerName}".`,
        );
        return {};
      });
    }

    for (const domain of started.domains) {
      await run(`remove custom domain ${domain.hostname}`, async ({ log, cf, orm }) => {
        let outcome: DetachOutcome;
        try {
          outcome = await detachCustomDomain(cf(), {
            hostname: domain.hostname,
            cfId: domain.cfId,
            workerName,
          });
        } catch (error) {
          if (!isPermissionError(error)) throw error;
          throw new JobError(
            `Cloudflare refused to remove the custom domain ${domain.hostname} (${errorMessage(error)}). The token needs Workers Routes: Edit on its zone; add it to the token and retry the uninstall`,
          );
        }
        log.info(detachMessage(domain.hostname, outcome));
        await orm
          .update(resources)
          .set({ deleted_at: new Date(now()) })
          .where(eq(resources.id, domain.id));
        return {};
      });
    }

    // A run started before wildcard domains existed carries none.
    for (const domain of started.wildcardDomains ?? []) {
      await run(`remove wildcard domain ${domain.hostname}`, async ({ log, cf, orm }) => {
        let done: Awaited<ReturnType<typeof detachWildcardParts>>;
        try {
          done = await detachWildcardParts(cf(), domain.parts);
        } catch (error) {
          if (!isPermissionError(error)) throw error;
          throw new JobError(
            `Cloudflare refused to remove the wildcard domain *.${domain.hostname} (${errorMessage(error)}). The token needs Workers Routes: Edit and DNS: Edit on its zone; add them to the token and retry the uninstall`,
          );
        }
        log.info(wildcardDetachMessage(domain.hostname, done));
        const ids = [...(domain.id === null ? [] : [domain.id]), ...domain.parts.map((p) => p.id)];
        await orm
          .update(resources)
          .set({ deleted_at: new Date(now()) })
          .where(inArray(resources.id, ids));
        return {};
      });
    }

    // A run started before consumers were recorded has none to remove.
    await removeQueueConsumersPhase(steps, workerName, started.consumers ?? []);

    // A run started before other Workers were listed has none.
    await deleteOtherWorkersPhase(steps, started.otherWorkers ?? []);

    const workerStep =
      started.worker === "live" ? `delete Worker ${workerName}` : `skip Worker ${workerName}`;
    await run(workerStep, async ({ log, cf, orm }) => {
      if (started.worker === "live") {
        try {
          await cf().workers.deleteScript(workerName, { force: true });
          log.info(
            `Deleted Worker "${workerName}" with its routes, cron triggers, secrets, and Durable Objects.`,
          );
        } catch (error) {
          if (!isNotFound(error)) throw error;
          log.info(`Worker "${workerName}" was already gone.`);
        }
      } else if (started.worker === "deleted") {
        log.info(`Worker "${workerName}" was deleted by an earlier run.`);
      } else {
        // Anything bound to a Worker that was never uploaded does not exist either.
        log.info(
          `No Worker is recorded for this install; skipping. A Worker named "${workerName}" in the account is not this install's and stays untouched.`,
        );
      }
      await orm
        .update(resources)
        .set({ deleted_at: new Date(now()) })
        .where(
          and(
            eq(resources.install_id, params.installId),
            isNull(resources.deleted_at),
            inArray(
              resources.kind,
              WORKER_BOUND_KINDS.filter((kind) => kind !== "workflow"),
            ),
          ),
        );
      return {};
    });

    // After the Worker and every address it answered on are gone, so the app
    // is never reachable without Access while this runs: its Access
    // application and its own service token. Nothing is exposed any more by
    // then, so a failure is a warning with what is left, never the job's.
    // A run started before protection existed carries no flag.
    if (started.accessProtected === true) {
      await run("remove Cloudflare Access protection", async ({ log, cf }) => {
        try {
          const removed = await withAccessLock(env.DB, () =>
            removeInstallAccess(
              { db: env.DB, client: cf(), now: () => new Date(now()) },
              params.installId,
            ),
          );
          log.info(
            removed.removed
              ? "Removed the app's Cloudflare Access application and its service token."
              : "The app's Cloudflare Access protection was already removed.",
          );
        } catch (error) {
          log.warn(
            `Could not remove the app's Cloudflare Access protection (${errorMessage(error)}). The app is gone, so nothing is exposed; delete its Access application and its "Appflare health checks ${params.installId}" service token under Zero Trust, Access.`,
          );
        }
        return {};
      });
    }

    // A run started before Workflows were listed deletes none (the Worker step marked them).
    for (const workflow of started.workflows ?? []) {
      await run(`delete Workflow ${workflow.name}`, async ({ log, cf, orm }) => {
        try {
          await cf().workflows.deleteWorkflow(workflow.name);
          log.info(`Deleted Workflow "${workflow.name}" with its instances.`);
        } catch (error) {
          if (!isNotFound(error)) throw error;
          log.info(`Workflow "${workflow.name}" was already gone.`);
        }
        await orm
          .update(resources)
          .set({ deleted_at: new Date(now()) })
          .where(eq(resources.id, workflow.id));
        return {};
      });
    }

    // A run started before Hyperdrive configurations were listed deletes none.
    for (const config of started.hyperdrive ?? []) {
      const label = RESOURCE_LABEL.hyperdrive;
      await run(`delete ${label} ${config.name}`, async ({ log, cf, orm }) => {
        try {
          if (await deleteResource(cf(), { kind: "hyperdrive", ...config })) {
            log.info(`Deleted ${label} "${config.name}"; the database itself is untouched.`);
          } else {
            log.warn(
              `No Cloudflare id is recorded for ${label} "${config.name}", so it cannot be addressed; marked deleted without a call. Check the Cloudflare dashboard for it.`,
            );
          }
        } catch (error) {
          if (!isNotFound(error)) throw error;
          log.info(`${label} "${config.name}" was already gone.`);
        }
        await orm
          .update(resources)
          .set({ deleted_at: new Date(now()) })
          .where(eq(resources.id, config.id));
        return {};
      });
    }

    // A run started before Pipelines were listed deletes none.
    for (const target of started.pipelines ?? []) {
      await run(
        `delete ${pipelineObjectLabel(target.kind)} ${target.name}`,
        async ({ log, cf, orm }) => {
          log.info(await deletePipelineObject(cf(), target));
          await orm
            .update(resources)
            .set({ deleted_at: new Date(now()) })
            .where(eq(resources.id, target.id));
          return {};
        },
      );
    }

    await deleteDataResourcesPhase(steps, started.targets, "uninstall");

    // The install's builds in the sandbox Worker's bucket (every version).
    if (started.sandboxBuilt === true) {
      await cleanupSandboxBuildsPhase(steps, env, params.installId, []);
    }

    await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm
          .update(installs)
          .set({ status: "uninstalled", uninstalled_at: at, updated_at: at })
          .where(eq(installs.id, params.installId)),
        orm
          .update(jobs)
          .set({ status: "succeeded", finished_at: at, error: null })
          .where(eq(jobs.id, params.jobId)),
      ]);
      const retained = await orm
        .select({ name: resources.name })
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            isNull(resources.deleted_at),
            isNotNull(resources.retained_at),
          ),
        );
      log.info(
        `Uninstalled "${workerName}".` +
          (retained.length > 0
            ? ` Kept in the account: ${retained.map((r) => r.name).join(", ")}.`
            : ""),
      );
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    await step.do("mark uninstall failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      // The install stays `uninstalling` so the install page offers a retry.
      await orm.update(installs).set({ updated_at: at }).where(eq(installs.id, params.installId));
      const log = new StepLog(now);
      log.error(
        `Uninstall failed at "${steps.current}". What was deleted stays deleted; retry the uninstall to delete the rest.`,
      );
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}

/**
 * Deletes data resources, one API call per step: an R2 bucket is emptied
 * first, a page per step, each page one job unit (`emptyR2Page`), and a run
 * stops after a bounded number of pages (the next run continues). Each
 * deleted resource gets `deleted_at`. Shared by the uninstall and by the
 * deletion of data an uninstall kept; `mode` only changes what the messages
 * tell the admin to do next.
 */
export async function deleteDataResourcesPhase(
  steps: JobSteps,
  targets: Target[],
  mode: "uninstall" | "retained",
): Promise<void> {
  const { run, now } = steps;
  const again = mode === "uninstall" ? "Retry the uninstall" : "Run Delete retained data again";
  /** R2 pages this run deleted, and the objects on them. */
  let r2Pages = 0;
  let r2Deleted = 0;
  const r2PageLimit = steps.units.remote ? R2_MAX_PAGES_PER_RUN : R2_MAX_LOCAL_PAGES_PER_RUN;
  const r2PerPage = steps.units.remote ? R2_OBJECTS_PER_STEP : R2_OBJECTS_PER_LOCAL_STEP;
  for (const target of targets) {
    const label = RESOURCE_LABEL[target.kind];
    if (target.kind === "r2") {
      const bucket = target.cfId ?? target.name;
      const catalogId = target.catalogId;
      if (catalogId !== undefined) {
        // Before the bucket is emptied: the catalog's table maintenance
        // writes files into it, and its records outlive the bucket otherwise.
        await run(`remove R2 Data Catalog ${target.name}`, async ({ log, cf, orm }) => {
          const outcome = await removeBucketCatalog(cf(), bucket);
          if (outcome.level === "warn") log.warn(outcome.message);
          else log.info(outcome.message);
          await orm
            .update(resources)
            .set({ deleted_at: new Date(now()) })
            .where(eq(resources.id, catalogId));
          return {};
        });
      }
      // Deleted objects drop out of the listing, so every page lists from the
      // start again. A first key seen twice means a delete did not take.
      let previousFirst: string | null = null;
      for (let page = 1; ; page++) {
        if (r2Pages >= r2PageLimit) {
          steps.current = `empty ${label} ${target.name}`;
          throw new JobError(
            `one run deletes at most ${r2PageLimit * r2PerPage} R2 objects (${r2PageLimit} page(s) of ${r2PerPage}); this run deleted ${r2Deleted}, and ${target.name} ${page === 1 ? "is not emptied yet" : "still holds more"}. ${again} to continue`,
          );
        }
        r2Pages += 1;
        const emptied = await run(`empty ${label} ${target.name} page ${page}`, async ({ log }) =>
          settleUnit(
            await steps.units.api.emptyR2Page({
              accountId: steps.accountId(),
              bucket,
              name: target.name,
              perPage: r2PerPage,
              previousFirst,
            }),
            log,
          ),
        );
        r2Deleted += emptied.deleted;
        if (!emptied.more) break;
        previousFirst = emptied.first;
      }
    }

    await run(`delete ${label} ${target.name}`, async ({ log, cf, orm }) => {
      try {
        if (await deleteResource(cf(), target)) log.info(`Deleted ${label} "${target.name}".`);
        else {
          log.warn(
            `No Cloudflare id is recorded for ${label} "${target.name}", so it cannot be addressed; marked deleted without a call. Check the Cloudflare dashboard for it.`,
          );
        }
      } catch (error) {
        if (target.kind === "r2" && error instanceof CloudflareApiError && error.status === 409) {
          // The REST API offers no way to list or abort incomplete multipart
          // uploads, which keep a bucket from being deleted.
          throw new JobError(
            `Cloudflare refused to delete the bucket (${error.message}). A bucket with incomplete multipart uploads cannot be deleted, and the Cloudflare API cannot list or abort them here; abort them with the S3 API or a lifecycle rule, ${mode === "uninstall" ? "or retry the uninstall and keep this bucket" : "then run Delete retained data again"}`,
          );
        }
        if (!isNotFound(error)) throw error;
        log.info(`${label} "${target.name}" was already gone.`);
      }
      await orm
        .update(resources)
        .set({ deleted_at: new Date(now()) })
        .where(eq(resources.id, target.id));
      return {};
    });
  }
}

/**
 * Deletes the data resources an uninstall kept (Settings, Removed apps). The
 * install is `uninstalled` and stays so; its Worker and everything bound to
 * it are gone already, so only the data resource steps of the uninstall run,
 * for the retained resources the start recorded. A resource that is already
 * gone counts as deleted, so running it again converges. On failure the job
 * records `<step>: <message>`; what was deleted stays deleted, and the rest
 * stays listed as kept.
 */
async function runDeleteRetained(ctx: JobContext, params: UninstallJobParams): Promise<void> {
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;
  try {
    const started = await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      const [install] = await orm
        .select({ workerName: installs.worker_name, status: installs.status })
        .from(installs)
        .where(eq(installs.id, params.installId))
        .limit(1);
      if (install === undefined) throw new JobError("the install no longer exists");
      if (install.status !== "uninstalled") {
        throw new JobError(
          "the install is not uninstalled; only data an uninstall kept is deleted here",
        );
      }
      const kept = await orm
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            isNull(resources.deleted_at),
            isNotNull(resources.retained_at),
          ),
        )
        .orderBy(sql`rowid`);
      const wanted = new Set(params.deleteResources);
      const candidates: Target[] = [];
      for (const r of kept) {
        if (!wanted.has(r.id) || r.managed_by === "app") continue;
        const kind = DATA_RESOURCE_KINDS.find((k) => k === r.kind);
        if (kind !== undefined) candidates.push({ id: r.id, kind, name: r.name, cfId: r.cf_id });
      }
      // A bucket or index is addressed by name. When another install records
      // one of that name (a later install under the same Worker name, after
      // the kept one was deleted by hand), it is that install's: never call
      // the API for it, and record it as gone from this app only.
      const held = await namesHeldElsewhere(env.DB, params.installId, candidates);
      // A kept bucket's Data Catalog was kept with it and goes with it now.
      const targets = withCatalogs(
        candidates.filter((t) => !held.has(t.id)),
        kept
          .filter((r) => r.kind === R2_CATALOG_KIND && r.managed_by !== "app")
          .map((r) => ({ id: r.id, name: r.name })),
      );
      for (const t of candidates) {
        const owner = held.get(t.id);
        if (owner === undefined) continue;
        log.warn(
          `${RESOURCE_LABEL[t.kind]} "${t.name}" is recorded by the install "${owner}" now, so it belongs to that install; left alone, and no longer listed as kept by this app.`,
        );
        await orm
          .update(resources)
          .set({ deleted_at: new Date(now()) })
          .where(eq(resources.id, t.id));
        // Its Data Catalog is that install's business too.
        for (const catalog of kept) {
          if (catalog.kind !== R2_CATALOG_KIND || catalog.name !== t.name || t.kind !== "r2") {
            continue;
          }
          await orm
            .update(resources)
            .set({ deleted_at: new Date(now()) })
            .where(eq(resources.id, catalog.id));
        }
      }
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      log.info(
        targets.length > 0
          ? `Deleting the data "${install.workerName}" kept: ${targets.map((t) => `${RESOURCE_LABEL[t.kind]} ${t.name}`).join(", ")}.`
          : `Nothing "${install.workerName}" kept is left to delete.`,
      );
      return {
        workerName: install.workerName,
        accountId: settings.account_id,
        targets,
        heldElsewhere: held.size,
      };
    });
    steps.setAccountId(started.accountId);

    await deleteDataResourcesPhase(steps, started.targets, "retained");

    await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm.update(installs).set({ updated_at: at }).where(eq(installs.id, params.installId)),
        orm
          .update(jobs)
          .set({ status: "succeeded", finished_at: at, error: null })
          .where(eq(jobs.id, params.jobId)),
      ]);
      const left = await orm
        .select({ name: resources.name })
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            isNull(resources.deleted_at),
            isNotNull(resources.retained_at),
          ),
        );
      log.info(
        left.length > 0
          ? `Deleted what was asked. Still kept in the account: ${left.map((r) => r.name).join(", ")}.`
          : started.heldElsewhere > 0
            ? `Deleted everything "${started.workerName}" kept that no other install uses now.`
            : `Deleted everything "${started.workerName}" kept. Nothing of it is left in the account.`,
      );
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    await step.do("mark delete retained data failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      const log = new StepLog(now);
      log.error(
        `Deleting the kept data failed at "${steps.current}". What was deleted stays deleted; run Delete retained data again to delete the rest.`,
      );
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
