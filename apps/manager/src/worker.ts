import handler from "@tanstack/react-start/server-entry";
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

  async scheduled(_controller, env) {
    if ((await migrated(env)) !== null) return;
    // TODO: refresh the catalog index into KV and set update-available per install.
  },
} satisfies ExportedHandler<Env>;
