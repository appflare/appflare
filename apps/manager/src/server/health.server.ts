import { isManagerUpdateAvailable, readManagerLatest } from "../catalog/manager-releases.server";
import { readSchemaVersion } from "../db/migrate";

export interface HealthBody {
  version: string;
  db: "ok" | "error";
  schemaVersion?: number;
  /** The newest Appflare release the release feed reported; null when none is known. */
  latestVersion: string | null;
  /** Whether `latestVersion` is newer than `version`. */
  updateAvailable: boolean;
}

/**
 * `GET /api/health`: unauthenticated; the build's version plus a D1 ping that
 * reads `schema_version`, and the newest release from the cron's KV cache (one
 * KV read, no outbound call). Canary checks compare `version` against the
 * version they just uploaded; `appflare status` reads `updateAvailable`.
 */
export async function healthResponse(env: {
  DB: D1Database;
  APPFLARE_VERSION: string;
  KV?: KVNamespace;
}): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  const release = await latestRelease(env);
  try {
    const schemaVersion = await readSchemaVersion(env.DB);
    const body: HealthBody = { version: env.APPFLARE_VERSION, db: "ok", schemaVersion, ...release };
    return Response.json(body, { headers });
  } catch (error) {
    console.error("health: D1 ping failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    const body: HealthBody = { version: env.APPFLARE_VERSION, db: "error", ...release };
    return Response.json(body, { status: 503, headers });
  }
}

/** Never fails the health check: an unreadable cache reports no release. */
async function latestRelease(env: {
  APPFLARE_VERSION: string;
  KV?: KVNamespace;
}): Promise<Pick<HealthBody, "latestVersion" | "updateAvailable">> {
  try {
    const latest = await readManagerLatest(env.KV);
    return {
      latestVersion: latest?.version ?? null,
      updateAvailable: isManagerUpdateAvailable(env.APPFLARE_VERSION, latest?.version),
    };
  } catch {
    return { latestVersion: null, updateAvailable: false };
  }
}
