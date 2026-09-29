import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SETTING } from "../db/settings";
import { runJob } from "../jobs/run-job";
import { TOKEN } from "../test/fake-account";
import {
  accessOn,
  addPasskey,
  addressRows,
  deps,
  fakeWorld,
  HOST,
  movedTo,
  NOW,
  passkeyHosts,
  seedAddressWorld,
  setting,
  VERSION,
  WORKER,
  WORKERS_DEV,
} from "../test/fake-address-world";
import { fakeStep } from "../test/fake-step";
import { changeManagerAddress, moveManagerAddress } from "./manager-address.server";
import {
  type MoveAddressJobParams,
  nextProbeDelaySeconds,
  runMoveAddress,
} from "./move-address-job";

/**
 * The job that moves Appflare's address, started as the request starts it
 * and run with a fake step whose sleeps move a fake clock. The world's
 * health endpoint answers from what is attached; nothing here touches an
 * account.
 */

beforeEach(async () => {
  await reset();
  await seedAddressWorld();
});

/** Parses a `step.sleep` duration ("5 seconds") into milliseconds. */
function sleepMs(duration: string | number): number {
  if (typeof duration === "number") return duration;
  const m = /^(\d+) seconds?$/.exec(duration);
  if (m?.[1] === undefined) throw new Error(`unexpected sleep ${duration}`);
  return Number(m[1]) * 1000;
}

type Start = "move" | "change";

/** Starts a move as the request does, then runs its job to the end. */
async function moveAndRun(
  w: ReturnType<typeof fakeWorld>,
  options: { start?: Start; overrideExistingDnsRecord?: boolean; jobId?: string } = {},
) {
  const { jobId } = options;
  const d = { ...deps(w), ...(jobId === undefined ? {} : { newId: () => jobId }) };
  const start = options.start === "change" ? changeManagerAddress : moveManagerAddress;
  const started = await start(d, {
    zoneId: "z-a",
    hostname: HOST,
    ...(options.overrideExistingDnsRecord ? { overrideExistingDnsRecord: true } : {}),
  });
  if (!started.ok) throw new Error("the move did not start");
  const params = d.started.at(-1);
  if (params === undefined) throw new Error("no job was started");
  return { started, params, ...(await runMove(w, params)) };
}

/** Runs one move job; returns the step record, and the error it ended with. */
async function runMove(
  w: ReturnType<typeof fakeWorld>,
  params: MoveAddressJobParams,
  db: D1Database = env.DB,
) {
  let clock = NOW.getTime();
  const step = fakeStep({ onSleep: (_name, duration) => (clock += sleepMs(duration)) });
  let error: unknown = null;
  try {
    await runJob(params, step, { DB: db, KV: env.KV, CF_API_TOKEN: TOKEN }, undefined, {
      fetch: w.anyFetch,
      now: () => clock,
    });
  } catch (err) {
    error = err;
  }
  return { step, error, elapsedMs: clock - NOW.getTime() };
}

async function job(id: string) {
  return env.DB.prepare("SELECT status, error, finished_at FROM jobs WHERE id = ?1")
    .bind(id)
    .first<{ status: string; error: string | null; finished_at: number | null }>();
}

async function logLines(id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT message FROM job_logs WHERE job_id = ?1 ORDER BY id",
  )
    .bind(id)
    .all<{ message: string }>();
  return results.map((r) => r.message);
}

const WAIT = "Waiting for the certificate and the new address";

describe("the move job", () => {
  it("switches at once when the new address answers the first probe", async () => {
    const w = fakeWorld();
    await addPasskey("pk1");
    const { started, step, error } = await moveAndRun(w);
    expect(error).toBeNull();
    expect(step.names).toEqual([
      "start",
      `${WAIT} (check 1)`,
      "Moving Cloudflare Access",
      "Switching the address",
      "finish",
    ]);
    expect(step.sleeps).toEqual([]);
    expect(w.world.probes).toEqual([`https://${HOST}/api/health`]);
    expect(await addressRows()).toEqual({
      manager_domain_id: "dom-1",
      manager_hostname: HOST,
      manager_moved_at: NOW.toISOString(),
      manager_previous_hostname: WORKERS_DEV,
      manager_zone_id: "z-a",
    });
    // Links no longer point at the old address, and the passkey is marked as the old address's.
    expect(await setting("notification_manager_url")).toBeNull();
    expect(await passkeyHosts()).toEqual([{ passkey_id: "pk1", hostname: WORKERS_DEV }]);
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBeNull();
    expect((await job(started.jobId))?.status).toBe("succeeded");
    expect(await logLines(started.jobId)).toEqual([
      `Moving Appflare to ${HOST}.`,
      `${WAIT}: https://${HOST}/api/health must answer as Appflare ${VERSION}.`,
      `${HOST} answers as this Appflare.`,
      `Switching the address: Appflare now lives at ${HOST}, and ${WORKERS_DEV} sends page visits there.`,
      `Appflare now lives at ${HOST}. Everyone signs in again there.`,
    ]);
  });

  it("waits with growing pauses while the certificate is issued, with a line about once a minute", async () => {
    const w = fakeWorld({ certificateAfter: 8 });
    const { started, step, error, elapsedMs } = await moveAndRun(w);
    expect(error).toBeNull();
    expect(step.sleepDurations).toEqual([
      "5 seconds",
      "5 seconds",
      "10 seconds",
      "10 seconds",
      "15 seconds",
      "15 seconds",
      "20 seconds",
      "20 seconds",
    ]);
    expect(elapsedMs).toBe(100_000);
    expect(w.world.probes).toHaveLength(9);
    const lines = await logLines(started.jobId);
    // Probes at 0, 5, 10, 20, 30, 45, 60, 80 and 100 seconds: one line at the minute.
    expect(lines.filter((l) => l.startsWith("Not answering yet"))).toEqual([
      "Not answering yet; certificates can take a few minutes (last answer: HTTP 526, error code 526).",
    ]);
    expect((await job(started.jobId))?.status).toBe("succeeded");
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
  });

  it("fails after 15 minutes without an answer, and leaves the domain attached", async () => {
    const w = fakeWorld({ health: { kind: "edge-1042" } });
    await addPasskey("pk1");
    const { started, step, error, elapsedMs } = await moveAndRun(w);
    expect(error).not.toBeNull();
    expect(w.world.probes).toHaveLength(24);
    expect(step.sleeps).toHaveLength(23);
    expect(elapsedMs).toBeLessThanOrEqual(15 * 60_000);
    const message = `${HOST} never answered as this Appflare within 15 minutes (last answer: HTTP 404, error code 1042), so Appflare stays at its current address. ${HOST} stays attached to Appflare's Worker. Start the move again from [Appflare's address settings](/settings/domains#address). A new domain's certificate sometimes takes longer; a new move waits another 15 minutes.`;
    expect(await job(started.jobId)).toMatchObject({ status: "failed", error: message });
    expect((await logLines(started.jobId)).at(-1)).toBe(message);
    // A line about once a minute while it waited.
    expect(
      (await logLines(started.jobId)).filter((l) => l.startsWith("Not answering yet")).length,
    ).toBeGreaterThanOrEqual(13);
    // Nothing detached, nothing switched; the record says who attached it for the next try.
    expect(w.world.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    expect(w.world.domains.has("dom-1")).toBe(true);
    expect(await addressRows()).toEqual({});
    expect(await setting("notification_manager_url")).toBe("https://appflare.ada.workers.dev");
    expect(await passkeyHosts()).toEqual([]);
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBe("appflare");
  });

  it("says the replaced DNS records are gone when such a domain never answers", async () => {
    const w = fakeWorld({
      health: { kind: "down" },
      records: { "z-a": [{ id: "r1", type: "A", name: HOST, content: "192.0.2.1" }] },
    });
    const { started } = await moveAndRun(w, { overrideExistingDnsRecord: true });
    expect((await job(started.jobId))?.error).toContain(
      `${HOST} stays attached to Appflare's Worker. The DNS records it replaced are gone, and Appflare cannot put them back.`,
    );
    expect(w.world.domains.has("dom-1")).toBe(true);
  });

  it("does not count another version's answer as this Appflare", async () => {
    const w = fakeWorld({ health: { kind: "serve", version: "1.3.9" } });
    const { started } = await moveAndRun(w);
    expect((await job(started.jobId))?.error).toContain("last answer: Appflare 1.3.9, not 1.4.0");
    expect(await addressRows()).toEqual({});
  });

  it("moves both Access applications and the protected hostname along when Access is on", async () => {
    const w = fakeWorld();
    await accessOn(w.world, WORKERS_DEV);
    await addPasskey("pk1");
    const { started, error } = await moveAndRun(w);
    expect(error).toBeNull();
    expect(w.world.apps.map((a) => a.domain)).toEqual([HOST, `${HOST}/api/health`]);
    expect(await setting(SETTING.accessDomain)).toBe(HOST);
    expect(await setting(SETTING.accessAud)).toBe("aud-1");
    expect(await passkeyHosts()).toEqual([{ passkey_id: "pk1", hostname: WORKERS_DEV }]);
    const lines = await logLines(started.jobId);
    expect(lines).toContain(`Moving Cloudflare Access to ${HOST}.`);
    expect(lines).toContain(`Cloudflare Access now protects ${HOST}.`);
    // Nothing moves before the new address answers.
    expect(w.world.calls.indexOf("PUT /access/apps/app-main")).toBeGreaterThan(
      w.world.calls.indexOf("PUT /workers/domains"),
    );
  });

  it("leaves Access alone when it is off", async () => {
    const w = fakeWorld();
    const { started } = await moveAndRun(w);
    expect(w.world.calls.filter((c) => c.includes("/access/"))).toEqual([]);
    expect((await logLines(started.jobId)).some((l) => l.includes("Cloudflare Access"))).toBe(
      false,
    );
  });

  it("records passkeys against the Access hostname on a first move", async () => {
    const w = fakeWorld();
    await accessOn(w.world, "gate.example.com");
    await addPasskey("pk1");
    await moveAndRun(w);
    expect(await passkeyHosts()).toEqual([{ passkey_id: "pk1", hostname: "gate.example.com" }]);
    expect(await setting(SETTING.managerPreviousHostname)).toBe("gate.example.com");
  });

  it("stops before switching when the token can no longer manage Access", async () => {
    const w = fakeWorld();
    await accessOn(w.world, WORKERS_DEV);
    const d = deps(w);
    const started = await moveManagerAddress(d, { zoneId: "z-a", hostname: HOST });
    if (!started.ok) throw new Error("the move did not start");
    // The permission went away while the job waited.
    w.world.refuse.set("GET /access/apps", 403);
    const params = d.started[0];
    if (params === undefined) throw new Error("no job");
    await runMove(w, params);
    expect((await job(started.jobId))?.error).toBe(
      `Moving Cloudflare Access: The Cloudflare token cannot manage Access applications. Add the Access: Apps and Policies: Edit permission to the token, then rotate it under Cloudflare token. Appflare stays at its current address. ${HOST} stays attached to Appflare's Worker. Start the move again from [Appflare's address settings](/settings/domains#address).`,
    );
    expect(await addressRows()).toEqual({});
    expect(w.world.apps.map((a) => a.domain)).toEqual([WORKERS_DEV, `${WORKERS_DEV}/api/health`]);
  });

  it("moves Access back and keeps the domain when the switch cannot be written", async () => {
    const w = fakeWorld();
    await accessOn(w.world, WORKERS_DEV);
    const d = deps(w);
    const started = await moveManagerAddress(d, { zoneId: "z-a", hostname: HOST });
    if (!started.ok) throw new Error("the move did not start");
    const params = d.started[0];
    if (params === undefined) throw new Error("no job");
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = async () => {
      throw new Error("D1 batch failed");
    };
    let result: Awaited<ReturnType<typeof runMove>>;
    try {
      result = await runMove(w, params);
    } finally {
      env.DB.batch = batch;
    }
    // Each attempt of the step moved Access and back again.
    expect(result.step.retried["Switching the address"]).toBe(4);
    expect(w.world.apps.map((a) => a.domain)).toEqual([WORKERS_DEV, `${WORKERS_DEV}/api/health`]);
    expect((await job(started.jobId))?.error).toContain(
      "Switching the address: D1 batch failed. Appflare stays at its current address.",
    );
    expect(w.world.domains.has("dom-1")).toBe(true);
    expect(await addressRows()).toEqual({});
    expect(await setting(SETTING.accessDomain)).toBe(WORKERS_DEV);
  });

  it("says Appflare moved when a step fails after its switch committed", async () => {
    const w = fakeWorld();
    await env.DB.prepare(
      `INSERT INTO notification_channels (id, kind, label, target, config, events_json, created_at, updated_at)
       VALUES ('c1', 'webhook', 'Ops', 'example.org', 'v1.x.y', '["manager_move_finished"]', 0, 0)`,
    ).run();
    const d = deps(w);
    const started = await moveManagerAddress(d, { zoneId: "z-a", hostname: HOST });
    const params = d.started[0];
    if (!started.ok || params === undefined) throw new Error("the move did not start");
    // The write after the switch (the attach record going) fails on every attempt.
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (sql !== "DELETE FROM settings WHERE key = ?1") return statement;
            return new Proxy(statement, {
              get(inner, key) {
                if (key !== "bind") return Reflect.get(inner, key).bind(inner);
                return (...values: unknown[]) =>
                  String(values[0]).startsWith("manager_domain_attached_by:")
                    ? {
                        run: async () => {
                          throw new Error("D1 is overloaded");
                        },
                      }
                    : inner.bind(...values);
              },
            });
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { error } = await runMove(w, params, db);
    expect(error).not.toBeNull();
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
    expect((await job(started.jobId))?.error).toBe(
      `Switching the address: D1 is overloaded. Appflare already lives at ${HOST}.`,
    );
    const event = await env.DB.prepare("SELECT facts_json FROM notification_events").first<{
      facts_json: string;
    }>();
    expect(JSON.parse(event?.facts_json ?? "{}")).toEqual({
      type: "manager_move_finished",
      hostname: HOST,
      outcome: "failed",
      jobId: started.jobId,
      moved: true,
    });
  });

  it("makes an Access policy again when an application answers without one", async () => {
    const w = fakeWorld({ dropPolicies: true });
    await accessOn(w.world, WORKERS_DEV);
    await moveAndRun(w);
    const posts = w.world.bodies.filter((b) => b.key.includes("/policies"));
    expect(posts.map((p) => p.key)).toEqual([
      "POST /access/apps/app-main/policies",
      "POST /access/apps/app-health/policies",
    ]);
    expect(await setting(SETTING.accessPolicyId)).not.toBe("pol-1");
  });

  it("switches from one domain to another, then detaches the old one", async () => {
    const w = fakeWorld();
    await movedTo(w.world, "old.example.com");
    await addPasskey("pk-dev");
    await addPasskey("pk-old");
    await addPasskey("pk-new");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO passkey_host (passkey_id, hostname, recorded_at) VALUES ('pk-dev', ?1, 1)",
      ).bind(WORKERS_DEV),
      env.DB.prepare(
        "INSERT INTO passkey_host (passkey_id, hostname, recorded_at) VALUES ('pk-new', ?1, 1)",
      ).bind(HOST),
    ]);
    const { started, step } = await moveAndRun(w, { start: "change" });
    expect(step.names.slice(-3)).toEqual([
      "Switching the address",
      "Detaching the old domain",
      "finish",
    ]);
    expect(w.world.calls.at(-1)).toBe("DELETE /workers/domains/dom-0");
    expect(await addressRows()).toMatchObject({
      manager_hostname: HOST,
      manager_previous_hostname: "old.example.com",
    });
    // Passkeys keep the address they were added at; those added at the new one work again.
    expect(await passkeyHosts()).toEqual([
      { passkey_id: "pk-dev", hostname: WORKERS_DEV },
      { passkey_id: "pk-old", hostname: "old.example.com" },
    ]);
    const lines = await logLines(started.jobId);
    expect(lines[0]).toBe(`Moving Appflare from old.example.com to ${HOST}.`);
    expect(lines).toContain("Detaching the old domain old.example.com.");
    expect(lines).toContain("Removed custom domain old.example.com.");
  });

  it("succeeds with a warning when the old domain cannot be detached", async () => {
    const w = fakeWorld({ refuse: new Map([["DELETE /workers/domains/dom-0", 403]]) });
    await movedTo(w.world, "old.example.com");
    const { started } = await moveAndRun(w, { start: "change" });
    expect((await job(started.jobId))?.status).toBe("succeeded");
    expect(await logLines(started.jobId)).toContain(
      "Could not detach old.example.com; it still points at Appflare's Worker. Remove it from the Worker's domains in the Cloudflare dashboard.",
    );
  });

  it("adopts a domain attached by hand and leaves it attached when it never answers", async () => {
    const w = fakeWorld({ health: { kind: "down" } });
    w.world.domains.set("dom-hand", {
      hostname: HOST,
      service: WORKER,
      zone_id: "z-a",
      zone_name: "example.com",
    });
    await moveAndRun(w);
    expect(w.world.domains.has("dom-hand")).toBe(true);
    expect(w.world.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);

    w.world.health = { kind: "serve", version: VERSION };
    w.world.probes.length = 0;
    const again = await moveAndRun(w, { jobId: "01MOVEJOBAGAIN" });
    expect(again.error).toBeNull();
    expect(await setting(SETTING.managerDomainId)).toBe("dom-hand");
  });

  it("records nothing against the address people used before an adoption", async () => {
    const w = fakeWorld();
    w.world.domains.set("dom-hand", {
      hostname: HOST,
      service: WORKER,
      zone_id: "z-a",
      zone_name: "example.com",
    });
    // The admins used the hand-attached domain: their passkeys belong to it.
    await env.DB.prepare("UPDATE settings SET value = ?1 WHERE key = 'notification_manager_url'")
      .bind(`https://${HOST}`)
      .run();
    await addPasskey("pk1");
    const { started } = await moveAndRun(w);
    expect(await passkeyHosts()).toEqual([]);
    expect(await setting(SETTING.managerPreviousHostname)).toBeNull();
    expect(await logLines(started.jobId)).toContain(
      `Switching the address: Appflare now lives at ${HOST}.`,
    );
  });

  it("tells notification channels how it ended, linking to the new address", async () => {
    const w = fakeWorld();
    await env.DB.prepare(
      `INSERT INTO notification_channels (id, kind, label, target, config, events_json, created_at, updated_at)
       VALUES ('c1', 'webhook', 'Ops', 'example.org', 'v1.x.y', '["manager_move_finished"]', 0, 0)`,
    ).run();
    const { started, step } = await moveAndRun(w);
    expect(step.names.at(-1)).toBe("notify channels");
    const event = await env.DB.prepare(
      "SELECT type, dedupe_key, facts_json FROM notification_events",
    ).first<{ type: string; dedupe_key: string; facts_json: string }>();
    expect(event).toEqual({
      type: "manager_move_finished",
      dedupe_key: `job:${started.jobId}`,
      facts_json: JSON.stringify({
        type: "manager_move_finished",
        hostname: HOST,
        outcome: "succeeded",
        jobId: started.jobId,
      }),
    });
  });

  it("rejects a payload without its fields", async () => {
    const step = fakeStep();
    await expect(
      runMoveAddress({
        params: { kind: "move_address", jobId: "j" },
        step,
        env: { DB: env.DB },
        deps: {},
      }),
    ).rejects.toThrow("invalid move job payload");
  });
});

describe("the wait's schedule", () => {
  it("probes 24 times within 15 minutes, quickly at first, then once a minute", () => {
    const delays: number[] = [];
    let elapsed = 0;
    for (let attempt = 1; ; attempt++) {
      const delay = nextProbeDelaySeconds(attempt, elapsed);
      if (delay === null) break;
      delays.push(delay);
      elapsed += delay * 1000;
    }
    expect(delays.slice(0, 12)).toEqual([5, 5, 10, 10, 15, 15, 20, 20, 30, 30, 30, 30]);
    expect(delays.slice(12).every((d) => d === 60)).toBe(true);
    expect(delays).toHaveLength(23);
    expect(elapsed).toBeLessThanOrEqual(15 * 60_000);
  });

  it("stops when the clock passes 15 minutes, however few probes ran", () => {
    expect(nextProbeDelaySeconds(2, 14 * 60_000 + 58_000)).toBeNull();
  });
});
