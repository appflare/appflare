import handler from "@tanstack/react-start/server-entry";
import { accessGate } from "./access/gate";
import {
  ACCESS_UPKEEP_IN_PLACE,
  ACCESS_UPKEEP_PARTS,
  accessUpkeepNeeded,
  logAccessUpkeep,
} from "./access/upkeep-run.server";
import { versionCreatedAt } from "./auth/recovery.server";
import { cleanUpRecoverySecret } from "./auth/recovery-cleanup.server";
import { ensureAuthStorage } from "./auth/storage.server";
import { runScheduledUpdates, scheduledUpdatesLog } from "./auto-update/cron.server";
import {
  refreshCapabilitiesAfterVersionChange,
  refreshCapabilitiesIfStale,
} from "./capabilities/capabilities.server";
import { ManagerReleasesError, refreshManagerReleases } from "./catalog/manager-releases.server";
import { refreshEnabledCatalogs } from "./catalog/refresh.server";
import { getCfClient } from "./cloudflare/client.server";
import { createDb } from "./db/client";
import { ensureMigrated } from "./db/migrate";
import { addressRedirect, serveRequest } from "./domains/address-redirect";
import { reconcileManagerAddress } from "./domains/manager-address.server";
import { finalizeSelfUpdates } from "./jobs/self-update/record";
import { scheduledExternalDomainCheck, scheduledNotifications } from "./notifications/cron.server";
import { selfNotificationUnits } from "./notifications/units";
import { reportTelemetry } from "./telemetry/report.server";

/**
 * The manager's Worker entry (custom entry so it can export more than
 * `fetch`). TanStack Start serves the SPA's server functions and server routes;
 * files under /assets/ never reach this code (wrangler.jsonc `assets`). Page
 * requests do, so the workers.dev address can redirect them to Appflare's
 * custom domain; the rest are served from the static assets.
 */

export { JobWorkflow } from "./jobs/job-workflow";
export { JobUnits } from "./jobs/units/entrypoint";

/** Set once this isolate has looked for a self-update to complete. */
let selfUpdatesFinalized = false;

/**
 * When this isolate may next look at whose account checks are stored:
 * never again once a look finished, a minute after one failed.
 */
let capabilitiesNextLook = 0;
/** Between a failed look and the next. */
const CAPABILITIES_RETRY_MS = 60_000;

/**
 * The first request of each isolate, after the response: when the stored
 * account checks were run by an older version (Appflare was updated) or
 * lack a probe this one runs, they run again now rather than with the
 * next day's cron, so the catalog and the install form read the running
 * version's answers within moments of an update. Starting protection with
 * Cloudflare Access never relies on them: it asks Cloudflare itself
 * (access/preflight.server.ts). One settings read per isolate otherwise; a
 * failure is logged, and a request a minute later (or the cron) tries again.
 */
function lookAtCapabilities(env: Env, ctx: ExecutionContext): void {
  if (Date.now() < capabilitiesNextLook) return;
  // None while this one runs, and none after it unless it fails.
  capabilitiesNextLook = Number.POSITIVE_INFINITY;
  ctx.waitUntil(
    refreshCapabilitiesAfterVersionChange(env, createDb(env.DB), {
      version: env.APPFLARE_VERSION,
    }).then(
      (result) => {
        if (result === "checked") {
          console.log(`account capabilities checked by version ${env.APPFLARE_VERSION}`);
        }
      },
      (error: unknown) => {
        capabilitiesNextLook = Date.now() + CAPABILITIES_RETRY_MS;
        console.error("account capability check after a version change failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    ),
  );
}

/**
 * A version that a self-update just promoted completes that job on its first
 * request (the switch may have ended the job's last step). Requests to a
 * version preview host (the self-update's own check, before the switch) never
 * do, and do not count as the first request. Never blocks serving: a failure
 * is logged and retried on the next request.
 */
async function finalizeOnce(env: Env, host: string | undefined): Promise<void> {
  if (selfUpdatesFinalized) return;
  try {
    const result = await finalizeSelfUpdates(env, host === undefined ? {} : { host });
    if (result.completed > 0) {
      console.log(`self-update completed by version ${env.APPFLARE_VERSION}`);
    }
    if (!result.previewHost) selfUpdatesFinalized = true;
  } catch (error) {
    console.error("self-update finalization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Self-migration runs before anything else. If it fails the
 * manager cannot serve correctly, so every request gets a 503 until it succeeds.
 */
async function migrated(env: Env, request?: Request): Promise<Response | null> {
  try {
    await ensureMigrated(env);
    await finalizeOnce(env, request === undefined ? undefined : new URL(request.url).host);
    return null;
  } catch (error) {
    console.error("self-migration failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "Appflare is migrating its database. Retry shortly." },
      {
        status: 503,
        headers: { "retry-after": "5" },
      },
    );
  }
}

/**
 * Better Auth's per-isolate storages, created by the first request before
 * anything else (see auth/storage.server.ts). A failure is logged and the
 * next request tries again; this request carries on.
 */
async function authStorage(ctx: ExecutionContext): Promise<void> {
  try {
    await ensureAuthStorage({ waitUntil: (promise) => ctx.waitUntil(promise) });
  } catch (error) {
    console.error("could not prepare Better Auth's request storage", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    await authStorage(ctx);
    const failed = await migrated(env, request);
    if (failed !== null) return failed;
    lookAtCapabilities(env, ctx);
    return (
      // Appflare's address: page requests at workers.dev go to its custom domain.
      (await addressRedirect.check(request, env.DB)) ??
      // Cloudflare Access protection, when on: checked before any routing.
      (await accessGate.check(request, env.DB, env.APPFLARE_VERSION)) ??
      // Pages and public files from the static assets (the SPA shell for any page).
      serveRequest(request, env.ASSETS, (r) => handler.fetch(r))
    );
  },

  /**
   * Cron: refresh every enabled catalog's index into KV, then check the manager's own
   * release feed. Update-available (for apps and for Appflare) is computed
   * at read time from those caches. Once a day, and whenever an older
   * version ran them, it also re-reads the account's capabilities
   * (capabilities/). Then the anonymous usage-data report
   * (telemetry/report.server.ts), which starts with the first run after setup
   * and sends nothing once an admin turns it off. It starts update jobs only for what automatic updates
   * allow (auto-update/), and only updates that need nothing from an admin. Last, it deletes a
   * recovery code secret that can no longer be used (auth/recovery-cleanup.server.ts).
   * Between those, the upkeep of apps protected with Cloudflare Access
   * (access/upkeep-run.server.ts), as three SELF units: newer catalog
   * revisions of their releases; service tokens with less than 30 days left
   * and "Appflare users" after a failed update; Access applications whose
   * sync failed or is due, and a check that they still exist.
   */
  async scheduled(_controller, env) {
    if ((await migrated(env)) !== null) return;
    // Every enabled catalog: one conditional fetch each (the official one also reads its stats).
    try {
      for (const line of await refreshEnabledCatalogs(env)) {
        if (line.ok) console.log(`catalog ${line.id} refreshed: ${line.apps} app(s)`);
        else console.error(`catalog ${line.id} refresh failed`, { error: line.error });
      }
    } catch (error) {
      console.error("catalog refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const latest = await refreshManagerReleases(env);
      console.log(`release feed checked: newest Appflare release ${latest?.version ?? "none"}`);
    } catch (error) {
      if (!(error instanceof ManagerReleasesError)) throw error;
      console.error("release feed check failed", { error: error.message });
    }
    // Account capabilities (R2, Containers, Workers plan, ...): once a UTC day,
    // and again when an older version stored them; one read call each.
    try {
      const capabilities = await refreshCapabilitiesIfStale(env, createDb(env.DB), {
        version: env.APPFLARE_VERSION,
      });
      if (capabilities === "checked") console.log("account capabilities checked");
    } catch (error) {
      console.error("account capability check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Apps protected with Cloudflare Access (access/upkeep-run.server.ts), in
    // three parts, in this order: newer catalog revisions of their releases
    // (which mark apps whose public paths changed), service tokens and the
    // users policy, then Access applications due a sync and the check that
    // they still exist. Each a SELF unit with its own invocation and
    // subrequest budget (in place without the binding); nothing at all while
    // no app has an Access record; never fails the run.
    try {
      if (await accessUpkeepNeeded(env.DB)) {
        const units = selfNotificationUnits(env);
        for (const part of ACCESS_UPKEEP_PARTS) {
          const result =
            units === undefined
              ? { ok: true as const, value: await ACCESS_UPKEEP_IN_PLACE[part](env) }
              : await units[part]({});
          if (result.ok) logAccessUpkeep(result.value);
          else console.error(`access: upkeep (${part}) failed`, { error: result.error });
        }
      }
    } catch (error) {
      console.error("access: upkeep of protected apps failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Automatic updates, from the caches refreshed above (auto-update/cron.server.ts).
    try {
      for (const line of scheduledUpdatesLog(await runScheduledUpdates(env))) console.log(line);
    } catch (error) {
      console.error("automatic updates failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Anonymous usage data, after the caches above are fresh; never fails the run.
    const usage = await reportTelemetry(env);
    if (usage.status === "failed") console.warn("usage data not sent", { reason: usage.reason });
    else if (usage.status === "sent" && usage.events > 0) {
      console.log(`usage data sent: ${usage.events} event(s)`);
    }
    // External domains: record their state and emit "Domain active" or
    // "Domain failed" for the delivery below; never fails the run.
    await scheduledExternalDomainCheck(env);
    // Appflare's address: when its custom domain no longer serves it, back to
    // workers.dev, with a notification delivered just below; never fails the run.
    try {
      const address = await reconcileManagerAddress({
        db: env.DB,
        api: () => getCfClient(env),
        invalidateAccessGate: () => accessGate.invalidate(),
      });
      if (address.status === "lost") {
        console.warn(`address: ${address.hostname} no longer serves Appflare; back at workers.dev`);
      }
    } catch (error) {
      console.error("address check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Notification channels: conditions, missed job ends, deliveries; never fails the run.
    await scheduledNotifications(env);
    // A recovery code secret that can no longer be used is deleted; never fails the run.
    try {
      const cleanup = await cleanUpRecoverySecret({
        d1: env.DB,
        secret: env.RECOVERY_CODE_HASH,
        since: versionCreatedAt(env.CF_VERSION_METADATA),
        now: new Date(),
        api: () => getCfClient(env),
        workflows: env.JOBS,
      });
      if (cleanup.outcome === "deleted") {
        console.log(`recovery code secret deleted (${cleanup.reason})`);
      } else if (cleanup.outcome === "skipped") {
        console.log(`recovery code secret kept for now: ${cleanup.reason}`);
      }
    } catch (error) {
      console.error("recovery code secret cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
} satisfies ExportedHandler<Env>;
