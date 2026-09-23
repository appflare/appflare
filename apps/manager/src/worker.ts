import handler from "@tanstack/react-start/server-entry";
import { CatalogError, refreshCatalogIndex } from "./catalog/index.server";
import { ensureMigrated } from "./db/migrate";

/**
 * The manager's Worker entry (custom entry so it can export more than
 * `fetch`). TanStack Start serves the SPA's server functions and server routes;
 * static assets never reach this code (wrangler.jsonc `assets`).
 */

export { JobWorkflow } from "./jobs/job-workflow";

/**
 * Self-migration runs before anything else. If it fails the
 * manager cannot serve correctly, so every request gets a 503 until it succeeds.
 */
async function migrated(env: Env): Promise<Response | null> {
  try {
    await ensureMigrated(env);
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
    return (await migrated(env)) ?? handler.fetch(request);
  },

  /**
   * Cron: refresh the catalog index into KV. Update-available is
   * computed at read time from the cached index, so nothing else is written.
   * The scheduled handler never starts jobs.
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
    // TODO: check the manager's own release feed.
  },
} satisfies ExportedHandler<Env>;
