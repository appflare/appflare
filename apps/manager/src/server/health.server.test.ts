import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { type HealthBody, healthResponse } from "./health.server";

beforeEach(async () => {
  await reset();
});

describe("GET /api/health", () => {
  it("reports the version, a working D1, and the schema version", async () => {
    await createMigrator(migrations).ensure(env.DB);
    const res = await healthResponse(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json<HealthBody>()).toEqual({
      version: env.APPFLARE_VERSION,
      db: "ok",
      schemaVersion: migrations.length,
    });
  });

  it("reports schema version 0 before the first migration", async () => {
    const body = await (await healthResponse(env)).json<HealthBody>();
    expect(body).toEqual({ version: env.APPFLARE_VERSION, db: "ok", schemaVersion: 0 });
  });

  it("returns 503 when D1 fails", async () => {
    const broken = {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database;
    const res = await healthResponse({ DB: broken, APPFLARE_VERSION: "1.2.3" });
    expect(res.status).toBe(503);
    expect(await res.json<HealthBody>()).toEqual({ version: "1.2.3", db: "error" });
  });
});
