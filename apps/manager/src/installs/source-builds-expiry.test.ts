import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sandboxObjectUrl } from "@appflare/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import type { NotificationUnitsApi } from "../notifications/units";
import {
  discardSourceBuildCore,
  EXPIRED_BUILDS_PER_RUN,
  type ExpiredSourceBuilds,
  expiredSourceBuildsLog,
  expireUnusedSourceBuildsCore,
} from "./source-builds.server";
import { scheduledSourceBuildExpiry } from "./source-builds-expiry.server";
import { UNUSED_BUILD_MS } from "./source-builds-retention";

/**
 * Builds for review nobody used: the cron throws them away after a week,
 * record and files together, and never one an install, a snapshot or a job
 * still needs. A record says `discarded` only once the files are gone.
 */

const NOW = new Date("2026-10-06T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Changed this long ago: past the expiry. */
const OLD = NOW.getTime() - UNUSED_BUILD_MS - DAY;
/** Changed this long ago: within it. */
const RECENT = NOW.getTime() - UNUSED_BUILD_MS + DAY;

interface Cleanup {
  installId: string;
  keep: string[];
}

let cleanups: Cleanup[] = [];

function deps(
  extra: { limit?: number; cleanup?: false | "fails"; now?: Date } = {},
): Parameters<typeof expireUnusedSourceBuildsCore>[0] {
  const now = extra.now ?? NOW;
  return {
    db: env.DB,
    now: () => now,
    ...(extra.cleanup === false
      ? {}
      : {
          cleanup: async (installId: string, keep: string[]) => {
            if (extra.cleanup === "fails") throw new Error("R2 is unavailable");
            cleanups.push({ installId, keep: [...keep].sort() });
          },
        }),
    ...(extra.limit === undefined ? {} : { limit: extra.limit }),
  };
}

function outcome(partial: Partial<ExpiredSourceBuilds>): ExpiredSourceBuilds {
  return { discarded: [], pending: [], left: [], skipped: [], more: false, ...partial };
}

async function seedBuild(opts: {
  id: string;
  installId?: string;
  purpose?: "install" | "update";
  status: string;
  version?: string | null;
  updatedAt: number;
}): Promise<void> {
  const installId = opts.installId ?? `new-${opts.id}`;
  const version = opts.version === undefined ? `0.0.0-${opts.id}` : opts.version;
  await env.DB.prepare(
    `INSERT INTO source_builds (id, install_id, purpose, origin, repo, status, version,
       artifact_key, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'repository', 'MendyLanda/cut', ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(
      opts.id,
      installId,
      opts.purpose ?? "install",
      opts.status,
      version,
      version === null ? null : artifactKey(installId, version),
      opts.updatedAt,
    )
    .run();
}

function artifactKey(installId: string, version: string): string {
  return `builds/${installId}/${version}/cut-${version}.zip`;
}

async function seedJob(opts: {
  id: string;
  installId?: string | null;
  kind?: string;
  status: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES (?1, ?2, ?3, ?4, '{}')`,
  )
    .bind(opts.id, opts.installId ?? null, opts.kind ?? "source_build", opts.status)
    .run();
}

/** An install from a repository at `version`, from a sandbox build (its own, unless `artifactUrl`). */
async function seedInstall(opts: {
  id: string;
  version: string;
  status?: string;
  artifactUrl?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       status, origin, build_kind, installed_at, updated_at)
     VALUES (?1, 'cut', ?1, ?1, ?2, ?3, ?4, 'repository', 'sandbox', 1, 1)`,
  )
    .bind(
      opts.id,
      opts.version,
      opts.artifactUrl ?? sandboxObjectUrl(artifactKey(opts.id, opts.version)),
      opts.status ?? "installed",
    )
    .run();
}

async function seedSnapshot(opts: {
  installId: string;
  version: string;
  takenAt?: number;
  artifactUrl?: string;
}): Promise<void> {
  const jobId = `update-${opts.installId}-from-${opts.version}`;
  await seedJob({ id: jobId, installId: opts.installId, kind: "update", status: "succeeded" });
  await env.DB.prepare(
    `INSERT INTO snapshots (id, install_id, job_id, worker_version_id, d1_bookmarks_json, taken_at,
       catalog_version, artifact_url, build_kind)
     VALUES (?1, ?2, ?3, 'wv', '{}', ?4, ?5, ?6, 'sandbox')`,
  )
    .bind(
      `snap-${opts.installId}-${opts.version}`,
      opts.installId,
      jobId,
      opts.takenAt ?? 1,
      opts.version,
      opts.artifactUrl ?? sandboxObjectUrl(artifactKey(opts.installId, opts.version)),
    )
    .run();
}

async function statusOf(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM source_builds WHERE id = ?1")
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
}

/** An old rebuild of install `i1` (at 2.0.0) that nobody used. */
async function staleRebuild(): Promise<void> {
  await seedBuild({
    id: "stale-rebuild",
    installId: "i1",
    purpose: "update",
    status: "built",
    version: "3.0.0",
    updatedAt: OLD,
  });
}

beforeEach(async () => {
  cleanups = [];
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("throwing away builds nobody used", () => {
  it("throws away a build older than the expiry with its files, and keeps a recent one", async () => {
    await seedBuild({ id: "old", status: "built", updatedAt: OLD });
    await seedBuild({ id: "recent", status: "built", updatedAt: RECENT });
    await seedJob({ id: "old", status: "succeeded" });
    await seedJob({ id: "recent", status: "succeeded" });

    const expired = await expireUnusedSourceBuildsCore(deps());

    expect(expired).toEqual(outcome({ discarded: ["old"] }));
    expect(await statusOf("old")).toBe("discarded");
    expect(await statusOf("recent")).toBe("built");
    // A new install's build has its own prefix: every object under it goes.
    expect(cleanups).toEqual([{ installId: "new-old", keep: [] }]);
    expect(expiredSourceBuildsLog(expired)).toBe(
      "source builds: 1 unused build(s) thrown away with their files",
    );
  });

  it("throws away failed builds too, including one whose job ended without recording it", async () => {
    await seedBuild({ id: "failed", status: "failed", version: null, updatedAt: OLD });
    await seedJob({ id: "failed", status: "failed" });
    await seedBuild({ id: "died", status: "building", version: null, updatedAt: OLD });
    await seedJob({ id: "died", status: "failed" });

    const expired = await expireUnusedSourceBuildsCore(deps());

    expect(expired.discarded.sort()).toEqual(["died", "failed"]);
    expect(await statusOf("failed")).toBe("discarded");
    expect(await statusOf("died")).toBe("discarded");
  });

  it("keeps a build still running, and one an install or update took", async () => {
    await seedBuild({ id: "running", status: "building", version: null, updatedAt: OLD });
    await seedJob({ id: "running", status: "running" });
    await seedBuild({ id: "queued", status: "building", version: null, updatedAt: OLD });
    await seedJob({ id: "queued", status: "queued" });
    await seedInstall({ id: "i-used", version: "0.0.0-used" });
    await seedBuild({
      id: "used",
      installId: "i-used",
      status: "used",
      version: "0.0.0-used",
      updatedAt: OLD,
    });

    expect(await expireUnusedSourceBuildsCore(deps())).toEqual(outcome({}));
    expect(await statusOf("running")).toBe("building");
    expect(await statusOf("queued")).toBe("building");
    expect(await statusOf("used")).toBe("used");
    expect(cleanups).toEqual([]);
  });

  it("keeps a build whose version an install or a snapshot uses, for a rollback", async () => {
    await seedInstall({ id: "i1", version: "2.0.0" });
    await seedSnapshot({ installId: "i1", version: "1.0.0" });
    // Rebuilds that came out at the versions in use (the same objects).
    for (const [id, version] of [
      ["same-as-installed", "2.0.0"],
      ["same-as-snapshot", "1.0.0"],
    ] as const) {
      await seedBuild({
        id,
        installId: "i1",
        purpose: "update",
        status: "built",
        version,
        updatedAt: OLD,
      });
    }

    expect(await expireUnusedSourceBuildsCore(deps())).toEqual(outcome({}));
    expect(await statusOf("same-as-installed")).toBe("built");
    expect(await statusOf("same-as-snapshot")).toBe("built");
    expect(cleanups).toEqual([]);
  });

  it("keeps a build whose artifact an install or a snapshot records, whatever its version", async () => {
    await seedBuild({ id: "by-install", status: "built", updatedAt: OLD });
    await seedBuild({ id: "by-snapshot", status: "built", updatedAt: OLD });
    await seedBuild({ id: "by-uninstalled", status: "built", updatedAt: OLD });
    // Other installs, at other versions, whose recorded artifact is the build's.
    await seedInstall({
      id: "i2",
      version: "9.9.9",
      artifactUrl: sandboxObjectUrl(artifactKey("new-by-install", "0.0.0-by-install")),
    });
    await seedInstall({ id: "i3", version: "9.9.9" });
    await seedSnapshot({
      installId: "i3",
      version: "8.8.8",
      artifactUrl: sandboxObjectUrl(artifactKey("new-by-snapshot", "0.0.0-by-snapshot")),
    });
    // An uninstalled app's record holds nothing back.
    await seedInstall({
      id: "i4",
      version: "9.9.9",
      status: "uninstalled",
      artifactUrl: sandboxObjectUrl(artifactKey("new-by-uninstalled", "0.0.0-by-uninstalled")),
    });

    const expired = await expireUnusedSourceBuildsCore(deps());

    expect(expired).toEqual(outcome({ discarded: ["by-uninstalled"] }));
    expect(await statusOf("by-install")).toBe("built");
    expect(await statusOf("by-snapshot")).toBe("built");
  });

  it("throws away an old rebuild but keeps the files the install, its snapshots and newer builds use", async () => {
    await seedInstall({ id: "i1", version: "2.0.0" });
    await seedSnapshot({ installId: "i1", version: "1.0.0" });
    await staleRebuild();
    await seedBuild({
      id: "fresh-rebuild",
      installId: "i1",
      purpose: "update",
      status: "built",
      version: "3.1.0",
      updatedAt: RECENT,
    });
    // An earlier update's build, long done: its version is no longer in use.
    await seedBuild({
      id: "long-used",
      installId: "i1",
      purpose: "update",
      status: "used",
      version: "1.5.0",
      updatedAt: OLD,
    });

    const expired = await expireUnusedSourceBuildsCore(deps());

    expect(expired.discarded).toEqual(["stale-rebuild"]);
    expect(await statusOf("fresh-rebuild")).toBe("built");
    expect(cleanups).toEqual([{ installId: "i1", keep: ["1.0.0", "2.0.0", "3.1.0"] }]);
  });

  it("keeps every snapshot's files, oldest included, and leaves them all when they are too many to name", async () => {
    await seedInstall({ id: "i1", version: "2.0.0" });
    // 15 snapshots and the current version: the most one clean-up can keep.
    for (let n = 0; n < 15; n++) {
      await seedSnapshot({ installId: "i1", version: `1.${n}.0`, takenAt: 1000 + n });
    }
    await staleRebuild();
    expect((await expireUnusedSourceBuildsCore(deps())).discarded).toEqual(["stale-rebuild"]);
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]?.keep).toContain("1.0.0");
    expect(cleanups[0]?.keep).toHaveLength(16);

    // One more snapshot: 17 versions in use. Leaving some out would delete
    // the files of a version a rollback can return to, so nothing is deleted.
    cleanups = [];
    await seedSnapshot({ installId: "i1", version: "1.15.0", takenAt: 2000 });
    await seedBuild({
      id: "another-stale",
      installId: "i1",
      purpose: "update",
      status: "built",
      version: "3.5.0",
      updatedAt: OLD,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const expired = await expireUnusedSourceBuildsCore(deps());

    expect(expired).toEqual(outcome({ left: ["another-stale"] }));
    expect(cleanups).toEqual([]);
    expect(await statusOf("another-stale")).toBe("discarded");
    expect(warn).toHaveBeenCalledWith(
      "source builds: a thrown-away build's files are left to the install's next update or uninstall",
      expect.objectContaining({ installId: "i1", keep: 17 }),
    );
    expect(expiredSourceBuildsLog(expired)).toContain(
      "the files of 1 left to the app's next update or uninstall",
    );
  });

  it("leaves an install's builds alone while a job of the install is queued or running", async () => {
    await seedInstall({ id: "i1", version: "2.0.0" });
    await staleRebuild();
    await seedJob({ id: "update-job", installId: "i1", kind: "update", status: "running" });

    expect(await expireUnusedSourceBuildsCore(deps())).toEqual(outcome({}));
    expect(await statusOf("stale-rebuild")).toBe("built");

    // The job ends: the next run takes it.
    await env.DB.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = 'update-job'").run();
    expect((await expireUnusedSourceBuildsCore(deps())).discarded).toEqual(["stale-rebuild"]);
  });

  it("keeps a build whose clean-up failed as being thrown away, says so, and finishes it later", async () => {
    await seedBuild({ id: "old", status: "built", updatedAt: OLD });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const failed = await expireUnusedSourceBuildsCore(deps({ cleanup: "fails" }));

    expect(failed).toEqual(outcome({ pending: ["old"] }));
    // Never offered again, never recorded as gone while its files are not.
    expect(await statusOf("old")).toBe("discarding");
    expect(warn).toHaveBeenCalledWith(
      "source builds: could not delete a thrown-away build's files; trying again later",
      { installId: "new-old", keep: 0, error: "R2 is unavailable" },
    );
    expect(expiredSourceBuildsLog(failed)).toContain("the files of 1 not deleted yet");

    // Not retried within the hour, so a build that keeps failing does not take every run's turn.
    expect(
      await expireUnusedSourceBuildsCore(deps({ now: new Date(NOW.getTime() + HOUR / 2) })),
    ).toEqual(outcome({}));
    const later = await expireUnusedSourceBuildsCore(
      deps({ now: new Date(NOW.getTime() + 2 * HOUR) }),
    );
    expect(later).toEqual(outcome({ discarded: ["old"] }));
    expect(await statusOf("old")).toBe("discarded");
    expect(cleanups).toEqual([{ installId: "new-old", keep: [] }]);
  });

  it("does nothing more on a second run", async () => {
    await seedBuild({ id: "old", status: "built", updatedAt: OLD });

    expect((await expireUnusedSourceBuildsCore(deps())).discarded).toEqual(["old"]);
    const again = await expireUnusedSourceBuildsCore(
      deps({ now: new Date(NOW.getTime() + 2 * HOUR) }),
    );

    expect(again).toEqual(outcome({}));
    expect(expiredSourceBuildsLog(again)).toBeNull();
    expect(cleanups).toHaveLength(1);
    expect(await statusOf("old")).toBe("discarded");
  });

  it("takes a few per run, oldest first, and says when more are due", async () => {
    const count = EXPIRED_BUILDS_PER_RUN + 2;
    const ids = Array.from({ length: count }, (_, i) => `old-${i}`);
    for (const [i, id] of ids.entries()) {
      await seedBuild({ id, status: "built", updatedAt: OLD - (count - i) * 1000 });
    }

    const first = await expireUnusedSourceBuildsCore(deps());
    expect(first.discarded).toEqual(ids.slice(0, EXPIRED_BUILDS_PER_RUN));
    expect(first.more).toBe(true);
    expect(expiredSourceBuildsLog(first)).toContain("more next run");

    const second = await expireUnusedSourceBuildsCore(deps());
    expect(second).toEqual(outcome({ discarded: ids.slice(EXPIRED_BUILDS_PER_RUN) }));
    expect(cleanups).toHaveLength(count);
  });

  it("changes only the records without the sandbox Worker", async () => {
    await seedBuild({ id: "old", status: "built", updatedAt: OLD });

    expect(await expireUnusedSourceBuildsCore(deps({ cleanup: false }))).toEqual(
      outcome({ discarded: ["old"] }),
    );
    expect(await statusOf("old")).toBe("discarded");
  });

  it("skips a build that was taken and given back since it was read", async () => {
    // An update took it and could not start, so it is waiting for review again from now.
    await seedBuild({ id: "given-back", status: "built", updatedAt: NOW.getTime() - 1000 });

    await expect(
      discardSourceBuildCore(deps(), "given-back", {
        idleBefore: new Date(NOW.getTime() - UNUSED_BUILD_MS),
      }),
    ).rejects.toThrow("The build changed meanwhile.");
    expect(await statusOf("given-back")).toBe("built");
    expect(cleanups).toEqual([]);
  });

  it("skips a build whose install started a job since it was read", async () => {
    await seedInstall({ id: "i1", version: "2.0.0" });
    await staleRebuild();
    await seedJob({ id: "other-install-job", installId: null, kind: "install", status: "running" });
    await seedJob({ id: "update-job", installId: "i1", kind: "update", status: "queued" });
    const idleBefore = new Date(NOW.getTime() - UNUSED_BUILD_MS);

    await expect(discardSourceBuildCore(deps(), "stale-rebuild", { idleBefore })).rejects.toThrow(
      "The build changed meanwhile.",
    );
    expect(await statusOf("stale-rebuild")).toBe("built");

    // Another install's job does not hold it back.
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = 'update-job'").run();
    expect(await discardSourceBuildCore(deps(), "stale-rebuild", { idleBefore })).toBe("deleted");
    expect(await statusOf("stale-rebuild")).toBe("discarded");
  });
});

describe("throwing a build away by hand", () => {
  it("leaves the files while a job of the install runs; the cron deletes them once it ends", async () => {
    await seedInstall({ id: "i1", version: "2.0.0" });
    await seedBuild({
      id: "rebuild",
      installId: "i1",
      purpose: "update",
      status: "built",
      version: "3.0.0",
      updatedAt: RECENT,
    });
    await seedJob({ id: "next-rebuild", installId: "i1", status: "running" });

    expect(await discardSourceBuildCore(deps(), "rebuild")).toBe("waiting");
    expect(await statusOf("rebuild")).toBe("discarding");
    expect(cleanups).toEqual([]);

    const later = deps({ now: new Date(NOW.getTime() + 2 * HOUR) });
    expect(await expireUnusedSourceBuildsCore(later)).toEqual(outcome({}));
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = 'next-rebuild'").run();
    expect(await expireUnusedSourceBuildsCore(later)).toEqual(outcome({ discarded: ["rebuild"] }));
    expect(await statusOf("rebuild")).toBe("discarded");
    expect(cleanups).toEqual([{ installId: "i1", keep: ["2.0.0"] }]);
  });

  it("keeps the version of a build just taken for an update whose job is being created", async () => {
    await seedInstall({ id: "i1", version: "2.0.0" });
    await seedBuild({
      id: "rebuild",
      installId: "i1",
      purpose: "update",
      status: "built",
      version: "3.0.0",
      updatedAt: RECENT,
    });
    await seedBuild({
      id: "taken",
      installId: "i1",
      purpose: "update",
      status: "used",
      version: "3.1.0",
      updatedAt: NOW.getTime() - 1000,
    });

    expect(await discardSourceBuildCore(deps(), "rebuild")).toBe("deleted");

    expect(cleanups).toEqual([{ installId: "i1", keep: ["2.0.0", "3.1.0"] }]);
  });

  it("is refused for a build already being thrown away", async () => {
    await seedBuild({ id: "going", status: "discarding", updatedAt: RECENT });

    await expect(discardSourceBuildCore(deps(), "going")).rejects.toThrow(
      "This build was thrown away already.",
    );
  });
});

describe("the scheduled expiry", () => {
  function fakeUnits(
    result: () => ReturnType<NotificationUnitsApi["expireSourceBuilds"]>,
  ): Pick<NotificationUnitsApi, "expireSourceBuilds"> & { calls: number } {
    const units = {
      calls: 0,
      expireSourceBuilds: () => {
        units.calls++;
        return result();
      },
    };
    return units;
  }

  it("reads once and starts no unit when nothing is due", async () => {
    await seedBuild({ id: "recent", status: "built", updatedAt: Date.now() });
    const units = fakeUnits(async () => ({ ok: true, value: outcome({}) }));

    expect(await scheduledSourceBuildExpiry({ DB: env.DB }, units)).toBe("idle");
    expect(units.calls).toBe(0);
  });

  it("runs the unit when a build is due, and logs what it did", async () => {
    await seedBuild({ id: "old", status: "built", updatedAt: Date.now() - UNUSED_BUILD_MS - DAY });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const units = fakeUnits(async () => ({ ok: true, value: outcome({ discarded: ["old"] }) }));

    expect(await scheduledSourceBuildExpiry({ DB: env.DB }, units)).toBe("ran");
    expect(units.calls).toBe(1);
    expect(log).toHaveBeenCalledWith(
      "source builds: 1 unused build(s) thrown away with their files",
    );
  });

  it("never fails the cron run: a failed or unreachable unit is logged", async () => {
    await seedBuild({ id: "old", status: "built", updatedAt: Date.now() - UNUSED_BUILD_MS - DAY });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const refused = fakeUnits(async () => ({ ok: false, error: "D1 is overloaded" }));
    await expect(scheduledSourceBuildExpiry({ DB: env.DB }, refused)).resolves.toBe("failed");
    const unreachable = fakeUnits(async () => {
      throw new Error("Too many subrequests");
    });
    await expect(scheduledSourceBuildExpiry({ DB: env.DB }, unreachable)).resolves.toBe("failed");

    expect(error).toHaveBeenCalledWith("expiring unused source builds failed", {
      error: "D1 is overloaded",
    });
    expect(error).toHaveBeenCalledWith("expiring unused source builds failed", {
      error: "Too many subrequests",
    });
    expect(await statusOf("old")).toBe("built");
  });

  it("runs the expiry in place without the SELF binding", async () => {
    await seedBuild({ id: "old", status: "built", updatedAt: Date.now() - UNUSED_BUILD_MS - DAY });
    vi.spyOn(console, "log").mockImplementation(() => {});

    // No SANDBOX either (sandbox builds were turned off): only the record changes.
    expect(await scheduledSourceBuildExpiry({ DB: env.DB })).toBe("ran");
    expect(await statusOf("old")).toBe("discarded");
  });
});
