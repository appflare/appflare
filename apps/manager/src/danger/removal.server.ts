import {
  CloudflareApiError,
  type CloudflareClient,
  FALLBACK_ORIGIN_NOT_SET,
} from "@appflare/cf-api";
import { SANDBOX_BUCKET_NAME, SANDBOX_WORKER_NAME } from "@appflare/schema";
import { serviceTokenName } from "../access/install-access.server";
import { createDb } from "../db/client";
import { deleteSettings, SETTING, writeSettings } from "../db/settings";
import { GATEWAY_WORKER_NAME, gatewayHostname } from "../gateway/gateway";
import type { GatewayState } from "../gateway/gateway.server";
import { detachCustomDomain } from "../installs/custom-domains.server";
import {
  R2_MAX_LOCAL_PAGES_PER_RUN,
  R2_MAX_PAGES_PER_RUN,
  R2_OBJECTS_PER_LOCAL_STEP,
  R2_OBJECTS_PER_STEP,
} from "../jobs/uninstall";
import { RELEASES_PER_CALL } from "../jobs/units/access";
import type { JobUnitsAccess } from "../jobs/units/client";
import { failureError } from "../jobs/units/result";
import { deletesBuildBucket } from "./danger";
import type { ManagerTargets, RemovalTargets } from "./removal-plan.server";

/**
 * Removing Appflare from the account: every step is one Cloudflare API call
 * (or one job unit), in this order:
 *
 * 1. the sandbox Worker's build bucket, when the sandbox Worker is
 *    Appflare's: emptied a page at a time through the `emptyR2Page` job unit
 *    (over `SELF`, which exists only while the manager Worker does, so it
 *    goes first), then deleted;
 * 2. the external domains gateway: its route, its Worker, the zone's fallback
 *    origin and the gateway's DNS record when Appflare set them, its routing
 *    table (the same pieces, in the same order, as turning it off);
 * 3. the sandbox Worker, then its two container applications (which
 *    Cloudflare keeps when the Worker goes) when the token has Containers;
 * 4. the manager's KV namespace; then, for apps protected with Cloudflare
 *    Access, each app's own service token is taken out of its Access
 *    application and deleted (the `releaseAppAccess` job unit, a few apps
 *    per call, each call in an invocation of its own over `SELF`): the
 *    applications and the "Appflare users" policy stay, so the apps stay
 *    protected, and the tokens' secrets would be lost with the database
 *    anyway. A failure there is reported and does not stop the removal:
 *    a token left behind is named on the page, left for you to delete in
 *    the Zero Trust dashboard. Then the D1 database;
 * 5. the Cloudflare Access applications in front of the manager, last, so a
 *    removal that stops at any earlier step leaves the manager protected.
 *
 * The manager Worker itself, and then its Workflow, are deleted by
 * {@link deleteManagerWorker}, which the caller runs after the final page,
 * once the D1 database is gone.
 *
 * Until the D1 database is deleted, a failed step, or a page that can no
 * longer be written (the browser went away), stops the removal: the manager
 * keeps working and running the removal again finishes it, because every
 * step treats "already gone" as done and the gateway records each removed
 * piece in its setting. From the D1 deletion on there is no way back, so
 * nothing stops the removal any more: page errors are ignored, and an Access
 * application that cannot be deleted is reported and left.
 *
 * This runs in one request, not a Workflow: the sandbox bucket's pages each
 * cost one subrequest (each page runs in its own invocation over `SELF`),
 * and so does each call releasing up to ten protected apps' tokens; the
 * rest is at most about 24 calls.
 */

export type RemovalStepStatus = "done" | "skipped" | "failed";

export interface RemovalStep {
  label: string;
  status: RemovalStepStatus;
  detail: string;
}

export interface RemovalDeps {
  db: D1Database;
  api: CloudflareClient;
  units: JobUnitsAccess;
  targets: RemovalTargets;
  /** Shows a step's result on the page. Throws when the page can no longer be written. */
  emit: (step: RemovalStep) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type RemovalOutcome =
  /**
   * The manager's data is gone and the manager Worker must be deleted.
   * `accessLeft`: Access applications that could not be deleted.
   * `pageLost`: the page stopped being written after the data was gone.
   */
  | { kind: "complete"; accessLeft: string[]; pageLost: boolean }
  /** A step failed before the D1 database was deleted; the manager keeps working. */
  | { kind: "failed"; step: RemovalStep }
  /** The page could not be written before the D1 database was deleted; nothing more was deleted. */
  | { kind: "page-lost" };

/** Tries at deleting the gateway's DNS record while its fallback origin goes (see gateway.server.ts). */
export const RECORD_DELETE_ATTEMPTS = 6;

class StepFailure extends Error {
  override name = "StepFailure";
}

class PageLost extends Error {
  override name = "PageLost";
}

function isGone(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    (error.status === 404 || error.errors.some((e) => e.code === FALLBACK_ORIGIN_NOT_SET))
  );
}

/** Runs one delete call: true when it deleted, false when it was already gone. */
async function deleted(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    if (isGone(error)) return false;
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type StepResult = { status: "done" | "skipped"; detail: string };
const done = (detail: string): StepResult => ({ status: "done", detail });
const skipped = (detail: string): StepResult => ({ status: "skipped", detail });
const deletedOrGone = async (run: () => Promise<unknown>, what = "Deleted.") =>
  (await deleted(run)) ? done(what) : skipped("It was already gone.");

export async function runRemoval(deps: RemovalDeps): Promise<RemovalOutcome> {
  const { api, targets } = deps;
  const orm = createDb(deps.db);
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  /** Set once the D1 database is gone: from then on nothing stops the removal. */
  let pastReturn = false;
  let pageLost = false;

  async function show(result: RemovalStep): Promise<void> {
    if (pageLost) return;
    try {
      await deps.emit(result);
    } catch (error) {
      pageLost = true;
      if (!pastReturn) throw new PageLost(message(error));
    }
  }

  /** Runs one step and shows its result. A thrown error fails the removal. */
  async function step(label: string, run: () => Promise<StepResult>): Promise<void> {
    let result: RemovalStep;
    try {
      result = { label, ...(await run()) };
    } catch (error) {
      const failed: RemovalStep = { label, status: "failed", detail: message(error) };
      await show(failed);
      throw new StepFailure(failed.detail, { cause: failed });
    }
    await show(result);
  }

  try {
    // 1. The build bucket, while SELF still exists; only Appflare's own.
    if (deletesBuildBucket(targets.sandbox)) {
      const remote = deps.units.remote;
      const perPage = remote ? R2_OBJECTS_PER_STEP : R2_OBJECTS_PER_LOCAL_STEP;
      const pageLimit = remote ? R2_MAX_PAGES_PER_RUN : R2_MAX_LOCAL_PAGES_PER_RUN;
      let previousFirst: string | null = null;
      for (let page = 1; ; page++) {
        let more = false;
        await step(`Empty the R2 bucket ${SANDBOX_BUCKET_NAME}, page ${page}`, async () => {
          if (page > pageLimit) {
            throw new Error(
              `one run deletes at most ${pageLimit * perPage} objects (${pageLimit} page${pageLimit === 1 ? "" : "s"} of ${perPage}), and the bucket still holds more. Run the removal again to continue; what is deleted stays deleted`,
            );
          }
          const result = await deps.units.api.emptyR2Page({
            accountId: api.accountId,
            bucket: SANDBOX_BUCKET_NAME,
            name: SANDBOX_BUCKET_NAME,
            perPage,
            previousFirst,
          });
          if (!result.ok) throw failureError(result.failure);
          more = result.value.more;
          previousFirst = result.value.first;
          return result.value.deleted === 0 && !more
            ? done("The bucket is empty.")
            : done(
                `Deleted ${result.value.deleted} object${result.value.deleted === 1 ? "" : "s"}.`,
              );
        });
        if (!more) break;
      }
      await step(`Delete the R2 bucket ${SANDBOX_BUCKET_NAME}`, async () => {
        try {
          return await deletedOrGone(() => api.r2.deleteBucket(SANDBOX_BUCKET_NAME));
        } catch (error) {
          if (error instanceof CloudflareApiError && error.status === 409) {
            throw new Error(
              `Cloudflare refused to delete the bucket (${error.message}). A bucket with incomplete multipart uploads cannot be deleted through the Cloudflare API; delete the bucket in the Cloudflare dashboard, then run the removal again`,
            );
          }
          throw error;
        }
      });
    }

    // 2. The external domains gateway, recording each removed piece.
    if (targets.gateway !== null) {
      let gateway: GatewayState = targets.gateway;
      const { zoneId, zoneName } = gateway;
      const save = (next: Partial<GatewayState>) => {
        gateway = { ...gateway, ...next };
        return writeSettings(
          orm,
          { [SETTING.externalDomainsGateway]: JSON.stringify(gateway) },
          now(),
        );
      };
      if (gateway.routeId !== null) {
        const routeId = gateway.routeId;
        await step(`Delete the route */* on ${zoneName}`, async () => {
          const result = await deletedOrGone(
            () => api.zones.deleteWorkerRoute(zoneId, routeId),
            "Deleted. Requests to the zone reach its origin again.",
          );
          await save({ routeId: null, readyAt: null });
          return result;
        });
      }
      await step(`Delete the Worker ${GATEWAY_WORKER_NAME}`, async () => {
        const result = await deletedOrGone(() =>
          api.workers.deleteScript(GATEWAY_WORKER_NAME, { force: true }),
        );
        await save({ workerUploaded: false });
        return result;
      });
      if (gateway.fallbackSet) {
        let ours = false;
        await step(`Check the fallback origin of ${zoneName}`, async () => {
          try {
            const current = await api.customHostnames.getFallbackOrigin(zoneId);
            ours = current.origin === gatewayHostname(zoneName);
          } catch (error) {
            if (!isGone(error)) throw error;
          }
          if (!ours) await save({ fallbackSet: false });
          return ours
            ? done("Appflare set it; it is removed next.")
            : skipped("It no longer points at the gateway, so it is left as it is.");
        });
        if (ours) {
          await step(`Remove the fallback origin of ${zoneName}`, async () => {
            const result = await deletedOrGone(
              () => api.customHostnames.deleteFallbackOrigin(zoneId),
              "Removed.",
            );
            await save({ fallbackSet: false });
            return result;
          });
        }
      }
      if (gateway.recordCreated && gateway.recordId !== null) {
        const recordId = gateway.recordId;
        await step(`Delete the DNS record ${gatewayHostname(zoneName)}`, async () => {
          // Cloudflare refuses (400) to delete the record for a moment while a
          // fallback origin that names it is still being removed.
          for (let attempt = 1; ; attempt++) {
            try {
              const result = await deletedOrGone(() => api.zones.deleteDnsRecord(zoneId, recordId));
              await save({ recordId: null, recordCreated: false });
              return result;
            } catch (error) {
              const busy = error instanceof CloudflareApiError && error.status === 400;
              if (!busy || attempt >= RECORD_DELETE_ATTEMPTS) throw error;
              await sleep(2000);
            }
          }
        });
      }
      const gatewayKv = gateway.kvId;
      await step("Delete the gateway's KV namespace and its record", async () => {
        const result =
          gatewayKv === null
            ? skipped("There was none.")
            : await deletedOrGone(() => api.kv.deleteNamespace(gatewayKv));
        await deleteSettings(orm, [SETTING.externalDomainsGateway]);
        return result;
      });
    }

    // 3. The sandbox Worker, with the installer tokens it holds.
    if (targets.sandbox.worker === "sandbox") {
      await step(`Delete the Worker ${SANDBOX_WORKER_NAME}`, () =>
        deletedOrGone(
          () => api.workers.deleteScript(SANDBOX_WORKER_NAME, { force: true }),
          "Deleted, with the secrets it held.",
        ),
      );
    }
    // Its container applications outlive it; deleted when the token can see them.
    for (const app of targets.sandbox.containerApps ?? []) {
      await step(`Delete the container application ${app.name}`, () =>
        deletedOrGone(() => api.containers.deleteApplication(app.id)),
      );
    }

    // 4. The manager's own data. Nothing is recorded after the D1 database goes.
    const { kvId, d1Id } = targets.manager;
    if (kvId !== null) {
      await step("Delete the manager's KV namespace", () =>
        deletedOrGone(() => api.kv.deleteNamespace(kvId)),
      );
    }
    // Protected apps keep their Access applications; their tokens go.
    const appAccess = targets.appAccessInstalls ?? [];
    for (let i = 0; i < appAccess.length; i += RELEASES_PER_CALL) {
      const chunk = appAccess.slice(i, i + RELEASES_PER_CALL);
      await show(await releaseAppAccessStep(deps, chunk));
    }
    if (d1Id !== null) {
      let result: StepResult;
      try {
        result = await deletedOrGone(
          () => api.d1.deleteDatabase(d1Id),
          "Deleted, with the users, jobs and settings it held.",
        );
      } catch (error) {
        const failed: RemovalStep = {
          label: "Delete the manager's D1 database",
          status: "failed",
          detail: message(error),
        };
        await show(failed);
        throw new StepFailure(failed.detail, { cause: failed });
      }
      pastReturn = true;
      await show({ label: "Delete the manager's D1 database", ...result });
    }
    pastReturn = true;
  } catch (error) {
    if (error instanceof StepFailure) return { kind: "failed", step: error.cause as RemovalStep };
    if (error instanceof PageLost) return { kind: "page-lost" };
    throw error;
  }

  // 5. Cloudflare Access, last: reported, never stopping the removal now.
  const accessLeft: string[] = [];
  for (const appId of targets.accessAppIds) {
    const label = "Delete a Cloudflare Access application of the manager";
    try {
      await show({ label, ...(await deletedOrGone(() => api.access.deleteApp(appId))) });
    } catch (error) {
      accessLeft.push(appId);
      await show({
        label,
        status: "failed",
        detail: `${message(error)}. Delete the application ${appId} under Zero Trust, Access, Applications.`,
      });
    }
  }
  return { kind: "complete", accessLeft, pageLost };
}

/**
 * One call of the `releaseAppAccess` unit for up to `RELEASES_PER_CALL`
 * protected apps, as a step result that never throws: a failure is shown,
 * with what is left, and the removal goes on.
 */
async function releaseAppAccessStep(
  deps: Pick<RemovalDeps, "api" | "units">,
  installIds: string[],
): Promise<RemovalStep> {
  const n = installIds.length;
  const label = `Take Appflare's health-check token out of ${n === 1 ? "a protected app" : `${n} protected apps`}`;
  const leftBehind = (ids: readonly string[]) =>
    `Their Access applications stay and keep the apps protected. Delete the service token${ids.length === 1 ? "" : "s"} ${ids.map((id) => `"${serviceTokenName(id)}"`).join(", ")} under Zero Trust, Access, Service credentials once no policy names ${ids.length === 1 ? "it" : "them"}.`;
  try {
    const answer = await deps.units.api.releaseAppAccess({
      accountId: deps.api.accountId,
      installIds,
    });
    if (!answer.ok) throw failureError(answer.failure);
    const { failed } = answer.value;
    if (failed.length === 0) {
      return {
        label,
        status: "done",
        detail:
          "Done. The Access applications stay, so the apps keep asking for a sign-in; who gets in is managed in the Zero Trust dashboard from now on.",
      };
    }
    return {
      label,
      status: "failed",
      detail: `${failed.map((f) => f.message).join("; ")}. ${leftBehind(failed.map((f) => f.installId))}`,
    };
  } catch (error) {
    return { label, status: "failed", detail: `${message(error)}. ${leftBehind(installIds)}` };
  }
}

/**
 * The last step, once the D1 database is gone and the final page was sent
 * (or could not be): the custom domain Appflare lives on, detached first
 * (a failure is logged: deleting the Worker removes it too), then the
 * manager Worker, with its cron trigger and workers.dev route, then its
 * Workflow. Deleting a Worker leaves the
 * Workflow it ran (and that Workflow's instances) in the account, so it is
 * deleted by name afterwards. True when the Worker was deleted (or was
 * already gone); a Workflow that cannot be deleted is logged.
 */
export async function deleteManagerWorker(
  api: CloudflareClient,
  manager: Pick<ManagerTargets, "workerName" | "workflowName" | "domain">,
): Promise<boolean> {
  const domain = manager.domain ?? null;
  if (domain !== null) {
    try {
      await detachCustomDomain(api, {
        hostname: domain.hostname,
        cfId: domain.domainId,
        workerName: manager.workerName,
      });
    } catch (error) {
      console.error(`removal: could not detach ${domain.hostname}`, { error: message(error) });
    }
  }
  try {
    await deleted(() => api.workers.deleteScript(manager.workerName, { force: true }));
  } catch (error) {
    console.error("removal: could not delete the manager Worker", { error: message(error) });
    return false;
  }
  const workflowName = manager.workflowName;
  if (workflowName !== null) {
    try {
      await deleted(() => api.workflows.deleteWorkflow(workflowName));
    } catch (error) {
      console.error(`removal: could not delete the Workflow ${workflowName}`, {
        error: message(error),
      });
    }
  }
  return true;
}
