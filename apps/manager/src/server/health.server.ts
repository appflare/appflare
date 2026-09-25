import { isManagerUpdateAvailable, readManagerLatest } from "../catalog/manager-releases.server";
import { KNOWN_SCHEMA_VERSION, readSchemaVersion } from "../db/migrate";
import { BUILD_VERSION, runningVersion } from "./build-version";

export interface HealthBody {
  version: string;
  db: "ok" | "error";
  schemaVersion?: number;
  /**
   * The migrations this build knows, so the newest database schema its code
   * was written for. A rollback asks the target version's preview for it and
   * refuses when the database is ahead (see jobs/self-update/rollback.ts).
   */
  knownSchemaVersion: number;
  /** The newest Appflare release the release feed reported; null when none is known. */
  latestVersion: string | null;
  /** Whether `latestVersion` is newer than `version`. */
  updateAvailable: boolean;
  /**
   * The version serving this request has `BETTER_AUTH_SECRET`. False on a
   * manager deployed without secrets until setup has written one and a
   * version with it serves; the setup page waits for it.
   */
  authReady: boolean;
}

/**
 * `GET /api/health`: unauthenticated; the build's version and the schema it
 * knows, plus a D1 ping that reads `schema_version`, and the newest release from the cron's KV cache (one
 * KV read, no outbound call). Canary checks compare `version` against the
 * version they just uploaded; `create-appflare` waits for `db` to be ok.
 * `version` is the one built into the code, not the `APPFLARE_VERSION` var,
 * which the Deploy to Cloudflare button's form lets anyone edit.
 */
export async function healthResponse(
  env: {
    DB: D1Database;
    APPFLARE_VERSION: string;
    KV?: KVNamespace;
    BETTER_AUTH_SECRET?: string;
  },
  build: string | null = BUILD_VERSION,
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  const version = runningVersion(env, build);
  const release = await latestRelease(env.KV, version);
  const authReady = typeof env.BETTER_AUTH_SECRET === "string" && env.BETTER_AUTH_SECRET.length > 0;
  try {
    const schemaVersion = await readSchemaVersion(env.DB);
    const body: HealthBody = {
      version,
      db: "ok",
      schemaVersion,
      knownSchemaVersion: KNOWN_SCHEMA_VERSION,
      ...release,
      authReady,
    };
    return Response.json(body, { headers });
  } catch (error) {
    console.error("health: D1 ping failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    const body: HealthBody = {
      version,
      db: "error",
      knownSchemaVersion: KNOWN_SCHEMA_VERSION,
      ...release,
      authReady,
    };
    return Response.json(body, { status: 503, headers });
  }
}

/** Never fails the health check: an unreadable cache reports no release. */
async function latestRelease(
  kv: KVNamespace | undefined,
  version: string,
): Promise<Pick<HealthBody, "latestVersion" | "updateAvailable">> {
  try {
    const latest = await readManagerLatest(kv);
    return {
      latestVersion: latest?.version ?? null,
      updateAvailable: isManagerUpdateAvailable(version, latest?.version),
    };
  } catch {
    return { latestVersion: null, updateAvailable: false };
  }
}
