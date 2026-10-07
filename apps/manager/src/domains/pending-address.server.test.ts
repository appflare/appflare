import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SETTING } from "../db/settings";
import {
  deps,
  fakeWorld,
  HOST,
  movedTo,
  seedAddressWorld,
  setting,
  VERSION,
  WORKER,
  WORKERS_DEV,
} from "../test/fake-address-world";
import { completeAddressMove, readManagerAddress } from "./manager-address.server";
import { identityVerdict } from "./manager-identity";
import {
  movePendingAddress,
  type PendingMove,
  passkeyMoveNotice,
  pendingMoveLog,
  readPendingAddress,
  recordPendingAddress,
  retryPendingMove,
  stayAtWorkersDev,
} from "./pending-address.server";

/**
 * A browser install handed over at workers.dev while its chosen domain did
 * not serve yet: the domain is pending, and Appflare moves there with the
 * usual move once an owner exists and the domain answers as this Appflare;
 * once, by itself.
 */

/** The handoff hash of this installation, and of some other one. */
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

beforeEach(async () => {
  await reset();
  await seedAddressWorld();
});

/** The installer attached `HOST` to the manager's Worker; it may not serve yet. */
function installedFor(over: Parameters<typeof fakeWorld>[0] = {}) {
  const w = fakeWorld(over);
  w.world.domains.set("dom-i", {
    hostname: HOST,
    service: WORKER,
    zone_id: "z-a",
    zone_name: "example.com",
  });
  return w;
}

function moveDeps(w: ReturnType<typeof fakeWorld>, handoffHash: string | null = null) {
  const d = deps(w);
  return { ...d, api: async () => w.api, fetch: w.fetch, handoffHash };
}

async function pending(w: ReturnType<typeof fakeWorld>) {
  return recordPendingAddress({
    db: env.DB,
    api: w.api,
    workerName: WORKER,
    intended: null,
    now: new Date(),
  });
}

async function jobRow(id: string) {
  return env.DB.prepare("SELECT kind, status, started_by FROM jobs WHERE id = ?1")
    .bind(id)
    .first<{ kind: string; status: string; started_by: string }>();
}

async function failJob(id: string) {
  await env.DB.prepare(
    "UPDATE jobs SET status = 'failed', error = 'Moving Cloudflare Access: refused.' WHERE id = ?1",
  )
    .bind(id)
    .run();
}

async function moveJobs(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'move_address'",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

async function started(result: PendingMove): Promise<string> {
  if (result.status !== "started") throw new Error(`not started: ${result.status}`);
  return result.jobId;
}

describe("recordPendingAddress", () => {
  it("takes the Worker's only custom domain, or the one named", async () => {
    const w = installedFor();
    expect(await pending(w)).toEqual({ hostname: HOST, zoneId: "z-a" });
    expect(await readPendingAddress(env.DB)).toMatchObject({ hostname: HOST, zoneId: "z-a" });
    w.world.domains.set("dom-j", {
      hostname: "manage.beta.dev",
      service: WORKER,
      zone_id: "z-b",
      zone_name: "beta.dev",
    });
    const named = await recordPendingAddress({
      db: env.DB,
      api: w.api,
      workerName: WORKER,
      intended: "MANAGE.beta.dev",
      now: new Date(),
    });
    expect(named).toEqual({ hostname: "manage.beta.dev", zoneId: "z-b" });
  });

  it("records nothing when it cannot tell which domain was chosen", async () => {
    expect(await pending(fakeWorld())).toBeNull();
    expect(await readPendingAddress(env.DB)).toBeNull();
  });
});

describe("movePendingAddress", () => {
  it("does nothing, after one read, when nothing is pending", async () => {
    const w = installedFor();
    expect(await movePendingAddress(moveDeps(w))).toEqual({ status: "none" });
    expect(w.world.calls).toEqual([]);
    expect(w.world.probes).toEqual([]);
  });

  it("waits for the owner: setup's claim belongs to the address in use", async () => {
    const w = installedFor();
    await pending(w);
    await env.DB.prepare("DELETE FROM user").run();
    expect(await movePendingAddress(moveDeps(w))).toEqual({ status: "waiting-for-owner" });
    expect(w.world.probes).toEqual([]);
  });

  it("waits quietly while the domain does not answer as this Appflare", async () => {
    const w = installedFor({ certificateAfter: 1 });
    await pending(w);
    const result = await movePendingAddress(moveDeps(w));
    expect(result).toMatchObject({ status: "not-serving" });
    expect(pendingMoveLog(result)).toBeNull();
    expect(w.world.probes).toEqual([`https://${HOST}/api/health`]);
    expect(await readPendingAddress(env.DB)).not.toBeNull();
  });

  it("starts the usual move once the domain serves, as an automatic job", async () => {
    const w = installedFor();
    await pending(w);
    const d = moveDeps(w);
    const jobId = await started(await movePendingAddress(d));
    expect(await jobRow(jobId)).toEqual({
      kind: "move_address",
      status: "queued",
      started_by: "schedule",
    });
    expect(d.started).toEqual([
      expect.objectContaining({ kind: "move_address", hostname: HOST, zoneId: "z-a" }),
    ]);
    // While that job runs, the next look starts nothing.
    expect(await movePendingAddress(d)).toEqual({ status: "moving", jobId });
    expect(d.started).toHaveLength(1);
  });

  it("stops after a failed move: marked failed once, no new job on later looks", async () => {
    const w = installedFor();
    await pending(w);
    const d = moveDeps(w);
    const jobId = await started(await movePendingAddress(d));
    await failJob(jobId);
    const failed = await movePendingAddress(d);
    expect(failed).toEqual({
      status: "move-failed",
      hostname: HOST,
      reason: "Moving Cloudflare Access: refused.",
    });
    expect(pendingMoveLog(failed)).toContain("waiting for an admin");
    // Page views and cron runs after that: nothing, quietly.
    for (let i = 0; i < 3; i++) {
      const again = await movePendingAddress(d);
      expect(again).toEqual({ status: "failed" });
      expect(pendingMoveLog(again)).toBeNull();
    }
    expect(d.started).toHaveLength(1);
    // One failed job, so one "move finished" notification (one per job).
    expect(await moveJobs()).toBe(1);
    const address = await readManagerAddress({ db: env.DB, api: w.api });
    expect(address.pending).toMatchObject({
      hostname: HOST,
      failure: "Moving Cloudflare Access: refused.",
    });
    expect(address.pending?.failedAt).not.toBeNull();
  });

  it("marks a refusal to start as failed too, and tries nothing more", async () => {
    const w = installedFor();
    await pending(w);
    w.world.refuse.set("GET /zones/z-a", 403);
    const d = moveDeps(w);
    const refused = await movePendingAddress(d);
    expect(refused.status).toBe("refused");
    expect(await movePendingAddress(d)).toEqual({ status: "failed" });
    expect(d.started).toEqual([]);
  });

  it("starts one job when the cron and a page look at the same moment; the other stays quiet", async () => {
    const w = installedFor();
    await pending(w);
    const d = moveDeps(w);
    const results = await Promise.all([movePendingAddress(d), movePendingAddress(d)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toContain("started");
    expect(["busy", "moving"]).toContain(statuses.find((s) => s !== "started"));
    expect(results.map(pendingMoveLog).filter((line) => line !== null)).toHaveLength(1);
    expect(d.started).toHaveLength(1);
    expect(await moveJobs()).toBe(1);
    expect((await readPendingAddress(env.DB))?.failedAt).toBeNull();
  });

  it("drops a pending domain no longer attached to the Worker, with a log line", async () => {
    const w = installedFor({ certificateAfter: 99 });
    await pending(w);
    w.world.domains.delete("dom-i");
    const result = await movePendingAddress(moveDeps(w));
    expect(result).toEqual({ status: "detached", hostname: HOST });
    expect(pendingMoveLog(result)).toContain("no longer attached");
    expect(await readPendingAddress(env.DB)).toBeNull();
  });

  it("drops a pending address left over when Appflare lives on a domain already", async () => {
    const w = installedFor();
    await pending(w);
    await movedTo(w.world, "manage.beta.dev");
    expect(await movePendingAddress(moveDeps(w))).toEqual({ status: "cleared" });
    expect(await readPendingAddress(env.DB)).toBeNull();
  });

  it("ends the pending address once the move switches", async () => {
    const w = installedFor();
    await pending(w);
    await completeAddressMove(
      { db: env.DB, api: w.api },
      { hostname: HOST, domainId: "dom-i", zoneId: "z-a", workerName: WORKER },
    );
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
    expect(await setting(SETTING.managerPreviousHostname)).toBe(WORKERS_DEV);
    expect(await readPendingAddress(env.DB)).toBeNull();
  });
});

describe("a browser-installed manager proves the domain is this installation", () => {
  it("moves when the domain gives this installation's handoff proof", async () => {
    const w = installedFor({ handoffHash: HASH });
    await pending(w);
    await started(await movePendingAddress(moveDeps(w, HASH)));
    expect(w.world.probes[0]).toMatch(
      new RegExp(`^https://${HOST}/api/handoff\\?challenge=[A-Za-z0-9_-]{32}$`),
    );
  });

  it("does not move when another installation answers there, even at the same version", async () => {
    const w = installedFor({ handoffHash: OTHER_HASH });
    await pending(w);
    expect(await movePendingAddress(moveDeps(w, HASH))).toEqual({
      status: "not-serving",
      last: "another Appflare, not this one (its handoff proof differs)",
    });
    // Its health report alone would have passed.
    expect(
      await identityVerdict(w.fetch, HOST, { version: VERSION, handoffHash: null }),
    ).toBeNull();
  });

  it("does not move when the domain has no handoff to prove", async () => {
    const w = installedFor();
    await pending(w);
    expect(await movePendingAddress(moveDeps(w, HASH))).toMatchObject({ status: "not-serving" });
  });
});

describe("what an admin can do with a pending address", () => {
  it("Try again starts one move by the admin and clears the failure", async () => {
    const w = installedFor();
    await pending(w);
    const d = moveDeps(w);
    await failJob(await started(await movePendingAddress(d)));
    await movePendingAddress(d);
    const moved = await retryPendingMove({ ...d, api: w.api });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(await jobRow(moved.jobId)).toMatchObject({ started_by: "admin" });
    expect(await readPendingAddress(env.DB)).toMatchObject({
      jobId: moved.jobId,
      failedAt: null,
    });
    // It fails again: marked failed again, still no automatic try.
    await failJob(moved.jobId);
    expect((await movePendingAddress(d)).status).toBe("move-failed");
    expect((await movePendingAddress(d)).status).toBe("failed");
    expect(await moveJobs()).toBe(2);
  });

  it("Stay at workers.dev ends it, failed or still waiting", async () => {
    const w = installedFor({ certificateAfter: 99 });
    await pending(w);
    await stayAtWorkersDev(env.DB);
    expect(await readPendingAddress(env.DB)).toBeNull();
    expect(await movePendingAddress(moveDeps(w))).toEqual({ status: "none" });
    // The domain stays attached; Domains settings offer it as a domain of the Worker.
    const address = await readManagerAddress({ db: env.DB, api: w.api });
    expect(address.pending).toBeNull();
    expect(address.attachedByHand.map((d) => d.hostname)).toEqual([HOST]);
  });
});

describe("Appflare's address while a domain is pending", () => {
  it("names the pending domain and does not offer it as attached by hand", async () => {
    const w = installedFor();
    await pending(w);
    const address = await readManagerAddress({ db: env.DB, api: w.api });
    expect(address.hostname).toBeNull();
    expect(address.pending).toEqual({ hostname: HOST, failedAt: null, failure: null });
    expect(address.attachedByHand).toEqual([]);
  });

  it("holds passkeys back at workers.dev only", async () => {
    const w = installedFor();
    expect(await passkeyMoveNotice(env.DB, WORKERS_DEV)).toBeNull();
    await pending(w);
    expect(await passkeyMoveNotice(env.DB, WORKERS_DEV)).toBe(HOST);
    expect(await passkeyMoveNotice(env.DB, HOST)).toBeNull();
  });
});
