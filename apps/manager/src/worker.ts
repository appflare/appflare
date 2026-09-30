import handler from "@tanstack/react-start/server-entry";
import { accessGate } from "./access/gate";
import {
  renewInstallServiceTokens,
  resyncAppAccessUsersIfFailed,
} from "./access/install-access.server";
import { versionCreatedAt } from "./auth/recovery.server";
import { cleanUpRecoverySecret } from "./auth/recovery-cleanup.server";
import { ensureAuthStorage } from "./auth/storage.server";
import { runScheduledUpdates, scheduledUpdatesLog } from "./auto-update/cron.server";
import { refreshCapabilitiesDaily } from "./capabilities/capabilities.server";
import { ManagerReleasesError, refreshManagerReleases } from "./catalog/manager-releases.server";
import { refreshEnabledCatalogs } from "./catalog/refresh.server";
import { getCfClient } from "./cloudflare/client.server";
import { createDb } from "./db/client";
import { ensureMigrated } from "./db/migrate";
import { addressRedirect, serveRequest } from "./domains/address-redirect";
import { reconcileManagerAddress } from "./domains/manager-address.server";
import { finalizeSelfUpdates } from "./jobs/self-update/record";
import { scheduledExternalDomainCheck, scheduledNotifications } from "./notifications/cron.server";
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
    return (
      (await migrated(env, request)) ??
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
   * at read time from those caches. Once a day it also re-reads the
   * account's capabilities (capabilities/). Then the anonymous usage-data report
   * (telemetry/report.server.ts), which starts with the first run after setup
   * and sends nothing once an admin turns it off. It starts update jobs only for what automatic updates
   * allow (auto-update/), and only updates that need nothing from an admin. Last, it deletes a
   * recovery code secret that can no longer be used (auth/recovery-cleanup.server.ts).
   * Between those, the upkeep of apps protected with Cloudflare Access
   * (access/install-access.server.ts): each app's service token is refreshed
   * once it has less than 30 days left, and "Appflare users" is synced again
   * when its last update after a user change failed.
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
    // Account capabilities (R2, Containers, Workers plan): once a UTC day, one read call each.
    try {
      const capabilities = await refreshCapabilitiesDaily(env, createDb(env.DB));
      if (capabilities === "checked") console.log("account capabilities checked");
    } catch (error) {
      console.error("account capability check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Apps protected with Cloudflare Access: D1 reads only, unless a token
    // expires within 30 days, its secret no longer reads, or the users policy
    // missed a change; never fails the run.
    try {
      const renewals = await renewInstallServiceTokens({
        db: env.DB,
        authSecret: env.BETTER_AUTH_SECRET,
        client: () => getCfClient(env),
      });
      for (const r of renewals) {
        const line = `access: service token of install ${r.installId} ${r.status}`;
        if (r.status === "failed") console.error(line, { error: r.detail });
        else if (r.status === "missing") console.warn(line);
        else console.log(line);
      }
      const users = await resyncAppAccessUsersIfFailed({
        db: env.DB,
        client: () => getCfClient(env),
      });
      if (users === "resynced") console.log("access: users policy of protected apps synced again");
      else if (users === "recreated") {
        console.warn(
          "access: users policy of protected apps was deleted and made again; protect each app again to use it",
        );
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
