import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MANAGER_LATEST_KEY } from "../catalog/manager-releases.server";
import { createMigrator, KNOWN_SCHEMA_VERSION } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { type HealthBody, healthResponse } from "./health.server";

beforeEach(async () => {
  await reset();
});

/** A release as the cron caches it in KV. */
function release(version: string) {
  return {
    version,
    tag: `manager@${version}`,
    assets: {
      zip: `https://example.test/appflare-${version}.zip`,
      manifest: "https://example.test/manifest.json",
      sig: "https://example.test/manifest.sig",
    },
    publishedAt: "2026-09-20T00:00:00Z",
    checkedAt: "2026-09-23T00:00:00.000Z",
  };
}

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
      knownSchemaVersion: migrations.length,
      latestVersion: null,
      updateAvailable: false,
      authReady: false,
    });
  });

  it("reports the version built into the code over an edited APPFLARE_VERSION var", async () => {
    await createMigrator(migrations).ensure(env.DB);
    await env.KV.put(MANAGER_LATEST_KEY, JSON.stringify(release("1.3.0")));
    const edited = { DB: env.DB, KV: env.KV, APPFLARE_VERSION: "9.9.9" };
    const body = await (await healthResponse(edited, "1.2.0")).json<HealthBody>();
    expect(body.version).toBe("1.2.0");
    expect(body.updateAvailable).toBe(true);
    // Without a built-in version (the unbuilt source in these tests), the var.
    expect((await (await healthResponse(edited, null)).json<HealthBody>()).version).toBe("9.9.9");
  });

  it("reports schema version 0 before the first migration", async () => {
    const body = await (await healthResponse(env)).json<HealthBody>();
    expect(body).toEqual({
      version: env.APPFLARE_VERSION,
      db: "ok",
      schemaVersion: 0,
      knownSchemaVersion: KNOWN_SCHEMA_VERSION,
      latestVersion: null,
      updateAvailable: false,
      authReady: false,
    });
  });

  it("returns 503 when D1 fails", async () => {
    const broken = {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database;
    const res = await healthResponse({ DB: broken, APPFLARE_VERSION: "1.2.3" });
    expect(res.status).toBe(503);
    expect(await res.json<HealthBody>()).toEqual({
      version: "1.2.3",
      db: "error",
      knownSchemaVersion: KNOWN_SCHEMA_VERSION,
      latestVersion: null,
      updateAvailable: false,
      authReady: false,
    });
  });

  it("reports the newest release the feed found, and whether it is newer", async () => {
    await createMigrator(migrations).ensure(env.DB);
    await env.KV.put(
      MANAGER_LATEST_KEY,
      JSON.stringify({
        version: "0.2.0",
        tag: "manager@0.2.0",
        assets: {
          zip: "https://example.test/appflare-0.2.0.zip",
          manifest: "https://example.test/manifest.json",
          sig: "https://example.test/manifest.sig",
        },
        publishedAt: "2026-09-20T00:00:00Z",
        checkedAt: "2026-09-23T00:00:00.000Z",
      }),
    );
    const newer = await (
      await healthResponse({ DB: env.DB, KV: env.KV, APPFLARE_VERSION: "0.1.0" })
    ).json<HealthBody>();
    expect(newer).toMatchObject({
      version: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
    });
    const same = await (
      await healthResponse({ DB: env.DB, KV: env.KV, APPFLARE_VERSION: "0.2.0" })
    ).json<HealthBody>();
    expect(same).toMatchObject({ latestVersion: "0.2.0", updateAvailable: false });
  });

  it("says whether the serving version has its auth secret, never the secret", async () => {
    const withSecret = await (
      await healthResponse({ DB: env.DB, APPFLARE_VERSION: "1.0.0", BETTER_AUTH_SECRET: "s3cret" })
    ).text();
    expect(JSON.parse(withSecret)).toMatchObject({ authReady: true });
    expect(withSecret).not.toContain("s3cret");
    const without = await (
      await healthResponse({ DB: env.DB, APPFLARE_VERSION: "1.0.0" })
    ).json<HealthBody>();
    expect(without.authReady).toBe(false);
  });
});
