import { readSchemaVersion } from "../db/migrate";

export interface HealthBody {
  version: string;
  db: "ok" | "error";
  schemaVersion?: number;
}

/**
 * `GET /api/health`: unauthenticated; the build's version plus a
 * D1 ping that reads `schema_version`. Canary checks
 * compare `version` against the version they just uploaded.
 */
export async function healthResponse(env: {
  DB: D1Database;
  APPFLARE_VERSION: string;
}): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  try {
    const schemaVersion = await readSchemaVersion(env.DB);
    const body: HealthBody = { version: env.APPFLARE_VERSION, db: "ok", schemaVersion };
    return Response.json(body, { headers });
  } catch (error) {
    console.error("health: D1 ping failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    const body: HealthBody = { version: env.APPFLARE_VERSION, db: "error" };
    return Response.json(body, { status: 503, headers });
  }
}
