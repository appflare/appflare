import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { checkInstallHealthCore, HealthCheckError } from "./health.server";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");

/** A fetch that answers `answer` and records the URLs it was asked for. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input: string) => {
      urls.push(input);
      return answer();
    },
  };
}

async function healthRow() {
  return env.DB.prepare("SELECT health_status, health_checked_at FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<{ health_status: string | null; health_checked_at: number | null }>();
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("checkInstallHealthCore", () => {
  it("probes the app's health path once and records the result", async () => {
    const fixture = await buildArtifactFixture({
      catalog: {
        install: {
          tier: "artifact",
          packageManager: "pnpm",
          wranglerConfig: "wrangler.jsonc",
          workerName: "cut",
          health: { path: "/api/health" },
        },
      },
    });
    await seedInstall({ manifestJson: new TextDecoder().decode(fixture.manifestBytes) });
    const f = fakeFetch(() => new Response('{"ok":true}', { status: 200 }));
    const result = await checkInstallHealthCore(
      { db: env.DB, fetch: f.fetch, now: () => NOW },
      { installId: INSTALL_ID },
    );
    expect(f.urls).toEqual(["https://cut.appflare-dev.workers.dev/api/health"]);
    expect(result).toEqual({
      status: "verified",
      detail: "HTTP 200",
      url: "https://cut.appflare-dev.workers.dev/api/health",
      checkedAt: "2026-09-23T12:00:00.000Z",
      recorded: true,
    });
    expect(await healthRow()).toEqual({ health_status: "verified", health_checked_at: NOW });
  });

  it("probes / when the manifest names no health path, and records a 5xx as unhealthy", async () => {
    await seedInstall();
    const f = fakeFetch(() => new Response("boom", { status: 500 }));
    const result = await checkInstallHealthCore(
      { db: env.DB, fetch: f.fetch, now: () => NOW },
      { installId: INSTALL_ID },
    );
    expect(f.urls).toEqual(["https://cut.appflare-dev.workers.dev/"]);
    expect(result.status).toBe("unhealthy");
    expect(await healthRow()).toEqual({ health_status: "unhealthy", health_checked_at: NOW });
  });

  it("records no answer or the edge's 1042 page as not verified", async () => {
    await seedInstall();
    const down = fakeFetch(() => {
      throw new TypeError("connection refused");
    });
    expect(
      (await checkInstallHealthCore({ db: env.DB, fetch: down.fetch }, { installId: INSTALL_ID }))
        .status,
    ).toBe("unverified");
    const edge = fakeFetch(() => new Response("error code: 1042", { status: 404 }));
    const result = await checkInstallHealthCore(
      { db: env.DB, fetch: edge.fetch },
      { installId: INSTALL_ID },
    );
    expect(result).toMatchObject({
      status: "unverified",
      detail: "404 error code: 1042 (route not live yet)",
    });
    expect((await healthRow())?.health_status).toBe("unverified");
  });

  it("does not record an answer when an update starts during the probe", async () => {
    await seedInstall();
    const f = fakeFetch(async () => {
      await env.DB.prepare("UPDATE installs SET status = 'updating' WHERE id = ?1")
        .bind(INSTALL_ID)
        .run();
      return new Response("boom", { status: 503 });
    });
    const result = await checkInstallHealthCore(
      { db: env.DB, fetch: f.fetch, now: () => NOW },
      { installId: INSTALL_ID },
    );
    expect(result).toMatchObject({ status: "unhealthy", recorded: false });
    expect(await healthRow()).toEqual({ health_status: null, health_checked_at: null });
  });

  it("refuses an install that is not installed, or does not exist, without probing", async () => {
    await seedInstall({ status: "updating" });
    const f = fakeFetch(() => new Response("ok"));
    await expect(
      checkInstallHealthCore({ db: env.DB, fetch: f.fetch }, { installId: INSTALL_ID }),
    ).rejects.toThrow(
      new HealthCheckError("Only an installed app can be checked; this one is updating."),
    );
    await expect(
      checkInstallHealthCore({ db: env.DB, fetch: f.fetch }, { installId: "nope" }),
    ).rejects.toThrow("There is no such install.");
    expect(f.urls).toEqual([]);
    expect(await healthRow()).toEqual({ health_status: null, health_checked_at: null });
  });
});
