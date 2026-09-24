import handler from "@tanstack/react-start/server-entry";
import { accessGate } from "./access/gate";
import { runScheduledUpdates, scheduledUpdatesLog } from "./auto-update/cron.server";
import { refreshCapabilitiesDaily } from "./capabilities/capabilities.server";
import { CatalogError, refreshCatalogIndex } from "./catalog/index.server";
import { ManagerReleasesError, refreshManagerReleases } from "./catalog/manager-releases.server";
import { createDb } from "./db/client";
import { ensureMigrated } from "./db/migrate";
import { finalizeSelfUpdates } from "./jobs/self-update/record";
import { scheduledNotifications } from "./notifications/cron.server";
import { reportTelemetry } from "./telemetry/report.server";

/**
 * The manager's Worker entry (custom entry so it can export more than
 * `fetch`). TanStack Start serves the SPA's server functions and server routes;
 * static assets never reach this code (wrangler.jsonc `assets`).
 */

export { JobWorkflow } from "./jobs/job-workflow";
export { JobUnits } from "./jobs/units/entrypoint";

/** Set once this isolate has looked for a self-update to complete. */
let selfUpdatesFinalized = false;

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

export default {
  async fetch(request, env) {
    return (
      (await migrated(env, request)) ??
      // Cloudflare Access protection, when on: checked before any routing.
      (await accessGate.check(request, env.DB)) ??
      handler.fetch(request)
    );
  },

  /**
   * Cron: refresh the catalog index into KV, then check the manager's own
   * release feed. Update-available (for apps and for Appflare) is computed
   * at read time from those caches. Once a day it also re-reads the
   * account's capabilities (capabilities/). Then the anonymous usage-data report
   * (telemetry/report.server.ts), which sends nothing until an admin has
   * seen the notice. It starts update jobs only for what automatic updates
   * allow (auto-update/), and only updates that need nothing from an admin.
   */
  async scheduled(_controller, env) {
    if ((await migrated(env)) !== null) return;
    try {
      const { index } = await refreshCatalogIndex(env);
      console.log(`catalog refreshed: ${index.apps.length} app(s)`);
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      console.error("catalog refresh failed", { error: error.message });
    }
    try {
      const latest = await refreshManagerReleases(env);
      console.log(`release feed checked: newest Appflare release ${latest?.version ?? "none"}`);
    } catch (error) {
      if (!(error instanceof ManagerReleasesError)) throw error;
      console.error("release feed check failed", { error: error.message });
    }
    // Account capabilities (R2, Containers, Workers plan): once a UTC day, one read call each.
    try {
      const capabilities = await refreshCapabilitiesDaily(env, createDb(env.DB));
      if (capabilities === "checked") console.log("account capabilities checked");
    } catch (error) {
      console.error("account capability check failed", {
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
    // Notification channels: conditions, missed job ends, deliveries; never fails the run.
    await scheduledNotifications(env);
  },
} satisfies ExportedHandler<Env>;
