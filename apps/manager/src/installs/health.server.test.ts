import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { accessChallenge } from "../test/access-sign-in";
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

async function accessFlag() {
  const row = await env.DB.prepare("SELECT health_access FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<{ health_access: number | null }>();
  return row?.health_access;
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

  it("records Cloudflare Access's sign-in redirect as not verified, naming Access", async () => {
    await seedInstall();
    const f = fakeFetch(() => accessChallenge("cut.appflare-dev.workers.dev"));
    const result = await checkInstallHealthCore(
      { db: env.DB, fetch: f.fetch, now: () => NOW },
      { installId: INSTALL_ID },
    );
    expect(result).toEqual({
      status: "unverified",
      detail: "Cloudflare Access asked for a sign-in",
      access: true,
      url: "https://cut.appflare-dev.workers.dev/",
      checkedAt: "2026-09-23T12:00:00.000Z",
      recorded: true,
    });
    expect(await healthRow()).toEqual({ health_status: "unverified", health_checked_at: NOW });
    expect(await accessFlag()).toBe(1);

    // The next check that reaches the app clears the flag.
    const reached = fakeFetch(() => new Response("ok"));
    await checkInstallHealthCore({ db: env.DB, fetch: reached.fetch }, { installId: INSTALL_ID });
    expect((await healthRow())?.health_status).toBe("verified");
    expect(await accessFlag()).toBe(0);
  });

  it("asks for the install's own token only after Access's sign-in, and probes again with it", async () => {
    await seedInstall();
    const sent: Array<Record<string, string>> = [];
    const asked: string[] = [];
    const deps = (answer: (headers: Record<string, string>) => Response) => ({
      db: env.DB,
      fetch: async (_url: string, init?: RequestInit) => {
        const headers = { ...(init?.headers as Record<string, string>) };
        sent.push(headers);
        return answer(headers);
      },
      probeHeaders: async (installId: string, url: string) => {
        asked.push(`${installId} ${url}`);
        return { "CF-Access-Client-Id": "id.access", "CF-Access-Client-Secret": "s" };
      },
      now: () => NOW,
    });
    const behindAccess = (headers: Record<string, string>) =>
      headers["CF-Access-Client-Secret"] === "s"
        ? new Response("ok")
        : accessChallenge("cut.appflare-dev.workers.dev");
    const result = await checkInstallHealthCore(deps(behindAccess), { installId: INSTALL_ID });
    expect(asked).toEqual([`${INSTALL_ID} https://cut.appflare-dev.workers.dev/`]);
    expect(sent.map((h) => h["CF-Access-Client-Secret"])).toEqual([undefined, "s"]);
    expect(result.status).toBe("verified");
    expect(JSON.stringify(result)).not.toContain("CF-Access");

    // An app that answers for itself is never asked for, nor sent, a token.
    sent.length = 0;
    asked.length = 0;
    await checkInstallHealthCore(
      deps(() => new Response("ok")),
      { installId: INSTALL_ID },
    );
    expect(asked).toEqual([]);
    expect(sent).toHaveLength(1);
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
