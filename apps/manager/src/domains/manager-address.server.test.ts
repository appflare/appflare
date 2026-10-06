import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ulid } from "ulidx";
import { beforeEach, describe, expect, it } from "vitest";
import { SETTING } from "../db/settings";
import { accessLoginUrl } from "../test/access-sign-in";
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
import {
  changeManagerAddress,
  completeAddressMove,
  listAddressOptions,
  managerVerdict,
  moveManagerAddress,
  readManagerAddress,
  readPasskeyHosts,
  reconcileManagerAddress,
  revertManagerAddress,
} from "./manager-address.server";

/**
 * Appflare's address against the local D1 and a stateful fake of the zones,
 * DNS records, Workers custom domains and Access applications API. A move
 * here is its start: the checks, the attach, and the job it starts; the job
 * itself is tested in move-address-job.test.ts.
 */

beforeEach(async () => {
  await reset();
  await seedAddressWorld();
});

async function jobRow(id: string) {
  return env.DB.prepare(
    "SELECT kind, status, input_json, started_by, workflow_instance_id, error FROM jobs WHERE id = ?1",
  )
    .bind(id)
    .first<{
      kind: string;
      status: string;
      input_json: string;
      started_by: string;
      workflow_instance_id: string | null;
      error: string | null;
    }>();
}

/** A job of `kind` queued or running, as another request left it. */
async function activeJob(id: string, kind: string, input: object = {}) {
  await env.DB.prepare(
    "INSERT INTO jobs (id, kind, status, input_json, workflow_instance_id) VALUES (?1, ?2, 'running', ?3, ?1)",
  )
    .bind(id, kind, JSON.stringify(input))
    .run();
}

describe("moveManagerAddress", () => {
  it("checks and attaches the hostname, then starts the job that waits and switches", async () => {
    const w = fakeWorld();
    const d = deps(w);
    const result = await moveManagerAddress(d, {
      zoneId: "z-a",
      hostname: " Appflare.Example.com ",
      returnTo: "/settings/domains#address",
    });
    const url = `https://${HOST}/login?returnTo=%2Fsettings%2Fdomains%23address&moved=1`;
    expect(result).toEqual({ ok: true, hostname: HOST, jobId: "01MOVEJOB00000000000000001", url });
    expect(w.world.calls).toEqual([
      "GET /zones/z-a",
      `GET /workers/domains?hostname=${HOST}`,
      `GET /workers/domains?hostname=${HOST}`,
      `GET /zones/z-a/dns_records?name.exact=${HOST}&page=1&per_page=100`,
      "PUT /workers/domains",
    ]);
    expect(w.world.bodies[0]?.body).toEqual({
      zone_id: "z-a",
      hostname: HOST,
      service: WORKER,
      environment: "production",
    });
    // Nothing waits in the request, and nothing switches before the job does.
    expect(w.world.probes).toEqual([]);
    expect(await addressRows()).toEqual({});
    expect(await setting("notification_manager_url")).toBe("https://appflare.ada.workers.dev");
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBe("appflare");
    expect(d.started).toEqual([
      {
        kind: "move_address",
        jobId: "01MOVEJOB00000000000000001",
        hostname: HOST,
        zoneId: "z-a",
        domainId: "dom-1",
        version: VERSION,
        from: null,
      },
    ]);
    const job = await jobRow("01MOVEJOB00000000000000001");
    expect(job).toMatchObject({
      kind: "move_address",
      status: "queued",
      started_by: "admin",
      workflow_instance_id: "instance-01MOVEJOB00000000000000001",
    });
    expect(JSON.parse(job?.input_json ?? "{}")).toEqual({
      hostname: HOST,
      zoneId: "z-a",
      from: null,
      url,
    });
  });

  it("answers dns-conflict with the records, and replaces them only when asked", async () => {
    const w = fakeWorld({
      records: { "z-a": [{ id: "r1", type: "A", name: HOST, content: "192.0.2.1" }] },
    });
    const d = deps(w);
    const conflict = await moveManagerAddress(d, { zoneId: "z-a", hostname: HOST });
    expect(conflict).toEqual({
      ok: false,
      reason: "dns-conflict",
      hostname: HOST,
      records: [{ type: "A", content: "192.0.2.1" }],
    });
    expect(w.world.calls).not.toContain("PUT /workers/domains");
    expect(d.started).toEqual([]);

    const moved = await moveManagerAddress(d, {
      zoneId: "z-a",
      hostname: HOST,
      overrideExistingDnsRecord: true,
    });
    expect(moved.ok).toBe(true);
    expect(w.world.bodies.at(-1)?.body).toMatchObject({ override_existing_dns_record: true });
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBe("appflare-replaced-records");
  });

  it("adopts a domain attached by hand without attaching it again", async () => {
    const w = fakeWorld();
    w.world.domains.set("dom-hand", {
      hostname: HOST,
      service: WORKER,
      zone_id: "z-a",
      zone_name: "example.com",
    });
    const d = deps(w);
    expect((await moveManagerAddress(d, { zoneId: "z-a", hostname: HOST })).ok).toBe(true);
    expect(w.world.calls).not.toContain("PUT /workers/domains");
    expect(d.started[0]?.domainId).toBe("dom-hand");
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBe("hand");
  });

  it("uses the domain an earlier move left attached, still as Appflare's own", async () => {
    const w = fakeWorld({
      records: { "z-a": [{ id: "r1", type: "A", name: HOST, content: "192.0.2.1" }] },
    });
    const first = deps(w);
    await moveManagerAddress(first, {
      zoneId: "z-a",
      hostname: HOST,
      overrideExistingDnsRecord: true,
    });
    // That job failed and left the domain attached.
    await env.DB.prepare("UPDATE jobs SET status = 'failed'").run();
    const again = await moveManagerAddress(
      { ...deps(w), newId: () => "01MOVEJOBAGAIN" },
      { zoneId: "z-a", hostname: HOST },
    );
    expect(again.ok).toBe(true);
    expect(w.world.calls.filter((c) => c === "PUT /workers/domains")).toHaveLength(1);
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBe("appflare-replaced-records");
  });

  it("refuses a second move while one runs, before attaching anything", async () => {
    const w = fakeWorld();
    await activeJob("01RUNNING", "move_address", { hostname: "other.example.com", zoneId: "z-a" });
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "Appflare is moving to other.example.com (job 01RUNNING). Wait for it to finish, then try again.",
    );
    expect(w.world.calls).toEqual([]);
  });

  it("settles a move whose Workflow instance is gone, then starts", async () => {
    const w = fakeWorld();
    await activeJob("01DEAD", "move_address", { hostname: "other.example.com", zoneId: "z-a" });
    const d = {
      ...deps(w),
      workflows: {
        get: async () => ({ status: async () => ({ status: "terminated" }) }),
      },
    };
    expect((await moveManagerAddress(d, { zoneId: "z-a", hostname: HOST })).ok).toBe(true);
    expect((await jobRow("01DEAD"))?.status).toBe("failed");
  });

  it("removes a move whose start never created its Workflow instance, after five minutes", async () => {
    const w = fakeWorld();
    const notFound = {
      get: async (id: string): Promise<never> => {
        throw new Error(`instance.not_found: ${id}`);
      },
    };
    const claim = (id: string) =>
      env.DB.prepare(
        "INSERT INTO jobs (id, kind, status, input_json) VALUES (?1, 'move_address', 'queued', ?2)",
      )
        .bind(id, JSON.stringify({ hostname: "other.example.com", zoneId: "z-a" }))
        .run();
    // A claim from a minute ago may still get its instance: it blocks.
    const fresh = ulid(Date.now() - 60_000);
    await claim(fresh);
    await expect(
      moveManagerAddress({ ...deps(w), workflows: notFound }, { zoneId: "z-a", hostname: HOST }),
    ).rejects.toThrow(`Appflare is moving to other.example.com (job ${fresh}).`);
    // One from ten minutes ago never will: it goes, and the move starts.
    await env.DB.prepare("DELETE FROM jobs").run();
    const stranded = ulid(Date.now() - 10 * 60_000);
    await claim(stranded);
    const moved = await moveManagerAddress(
      { ...deps(w), workflows: notFound },
      { zoneId: "z-a", hostname: HOST },
    );
    expect(moved.ok).toBe(true);
    expect(await jobRow(stranded)).toBeNull();
  });

  it("refuses while Appflare updates itself", async () => {
    const w = fakeWorld();
    await activeJob("01SELF", "self_update", { version: "1.5.0" });
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "Appflare is updating itself (job 01SELF).",
    );
    expect(w.world.calls).toEqual([]);
  });

  it("fails the job and keeps the domain when its Workflow cannot be created", async () => {
    const w = fakeWorld();
    const d = {
      ...deps(w),
      createJob: async () => {
        throw new Error("Workflows unavailable");
      },
    };
    await expect(moveManagerAddress(d, { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      `Appflare could not start the move: could not create the job: Workflows unavailable. ${HOST} stays attached to Appflare's Worker; try again.`,
    );
    expect((await jobRow("01MOVEJOB00000000000000001"))?.status).toBe("failed");
    expect(w.world.domains.has("dom-1")).toBe(true);
    // Not held up by the job that never started.
    const again = { ...deps(w), newId: () => "01MOVEJOBAGAIN" };
    expect((await moveManagerAddress(again, { zoneId: "z-a", hostname: HOST })).ok).toBe(true);
  });

  it("refuses before attaching anything when the token cannot manage Access", async () => {
    const w = fakeWorld({ refuse: new Map([["GET /access/apps", 403]]) });
    await accessOn(w.world, WORKERS_DEV);
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "The Cloudflare token cannot manage Access applications.",
    );
    expect(w.world.calls).not.toContain("PUT /workers/domains");
  });

  it("refuses a hostname another Access application protects", async () => {
    const w = fakeWorld();
    await accessOn(w.world, WORKERS_DEV);
    w.world.apps.push({ id: "other", aud: "x", name: "Wiki", domain: HOST, policies: [] });
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      'An Access application for this hostname already exists ("Wiki")',
    );
  });

  it("refuses a hostname that serves an installed app, naming the app", async () => {
    const w = fakeWorld();
    w.world.domains.set("dom-app", {
      hostname: HOST,
      service: "wiki",
      zone_id: "z-a",
      zone_name: "example.com",
    });
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, display_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('i1', 'wiki', 'wiki', 'Team wiki', '1', 'u', 'installed', 1, 1)`,
    ).run();
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      `${HOST} already serves the app Team wiki.`,
    );
  });

  it("refuses a hostname that serves another Worker", async () => {
    const w = fakeWorld();
    w.world.domains.set("dom-x", {
      hostname: HOST,
      service: "blog",
      zone_id: "z-a",
      zone_name: "example.com",
    });
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      `${HOST} already serves the Worker "blog".`,
    );
  });

  it("refuses the gateway's hostname, a hostname outside the zone, and a second move", async () => {
    const w = fakeWorld();
    await expect(
      moveManagerAddress(deps(w), { zoneId: "z-a", hostname: "appflare-gateway.example.com" }),
    ).rejects.toThrow("external domains gateway");
    await expect(
      moveManagerAddress(deps(w), { zoneId: "z-a", hostname: "appflare.other.org" }),
    ).rejects.toThrow("The hostname must be example.com or end in .example.com.");
    await movedTo(w.world, "old.example.com");
    await expect(moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "Appflare already lives at old.example.com. Use Change",
    );
  });
});

describe("changeManagerAddress", () => {
  it("starts a job that knows the domain it leaves", async () => {
    const w = fakeWorld();
    await movedTo(w.world, "old.example.com");
    const d = deps(w);
    const result = await changeManagerAddress(d, { zoneId: "z-a", hostname: HOST });
    expect(result).toMatchObject({ ok: true, hostname: HOST });
    expect(d.started[0]?.from).toEqual({ hostname: "old.example.com", domainId: "dom-0" });
    // The old domain serves until the job has switched.
    expect(w.world.domains.has("dom-0")).toBe(true);
    expect(await setting(SETTING.managerHostname)).toBe("old.example.com");
  });

  it("refuses without an address to change, and the same address", async () => {
    const w = fakeWorld();
    await expect(changeManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      "Appflare lives at its workers.dev address.",
    );
    await movedTo(w.world, HOST);
    await expect(changeManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST })).rejects.toThrow(
      `Appflare already lives at ${HOST}.`,
    );
  });
});

describe("completeAddressMove", () => {
  it("does nothing more when run again after its switch committed", async () => {
    const w = fakeWorld();
    await accessOn(w.world, WORKERS_DEV);
    await addPasskey("pk1");
    await moveManagerAddress(deps(w), { zoneId: "z-a", hostname: HOST });
    const move = { hostname: HOST, domainId: "dom-1", zoneId: "z-a", workerName: WORKER };
    const first = await completeAddressMove(deps(w), move);
    expect(first).toEqual({ from: WORKERS_DEV, accessMoved: true });
    const accessCalls = w.world.calls.filter((c) => c.includes("/access/")).length;
    const hosts = await passkeyHosts();
    // As if the first run's record delete had not happened.
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, 'appflare', 0)")
      .bind(`manager_domain_attached_by:${HOST}`)
      .run();

    const second = await completeAddressMove(deps(w), move);
    expect(second.accessMoved).toBe(false);
    expect(w.world.calls.filter((c) => c.includes("/access/")).length).toBe(accessCalls);
    expect(await passkeyHosts()).toEqual(hosts);
    expect(await setting(`manager_domain_attached_by:${HOST}`)).toBeNull();
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
  });
});

describe("revertManagerAddress", () => {
  it("moves Access back, clears the rows, then detaches the domain", async () => {
    const w = fakeWorld();
    await movedTo(w.world, HOST);
    await accessOn(w.world, HOST);
    await addPasskey("pk-dev");
    await addPasskey("pk-host");
    await env.DB.prepare(
      "INSERT INTO passkey_host (passkey_id, hostname, recorded_at) VALUES ('pk-dev', ?1, 1)",
    )
      .bind(WORKERS_DEV)
      .run();
    const result = await revertManagerAddress(deps(w), {});
    expect(result).toEqual({
      wasMoved: true,
      url: `https://${WORKERS_DEV}/login?returnTo=%2Fsettings%2Fdomains%23address&moved=1`,
      previousDomain: "detached",
    });
    expect(w.world.calls).toEqual([
      "PUT /access/apps/app-main",
      "PUT /access/apps/app-health",
      "DELETE /workers/domains/dom-0",
    ]);
    expect(w.world.apps.map((a) => a.domain)).toEqual([WORKERS_DEV, `${WORKERS_DEV}/api/health`]);
    expect(await setting(SETTING.accessDomain)).toBe(WORKERS_DEV);
    expect(await addressRows()).toEqual({});
    expect(await passkeyHosts()).toEqual([{ passkey_id: "pk-host", hostname: HOST }]);
  });

  it("changes nothing when Access cannot be moved back", async () => {
    const w = fakeWorld({ refuse: new Map([["PUT /access/apps/app-main", 403]]) });
    await movedTo(w.world, HOST);
    await accessOn(w.world, HOST);
    await expect(revertManagerAddress(deps(w), {})).rejects.toThrow(
      "The Cloudflare token cannot manage Access applications.",
    );
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
    expect(w.world.domains.has("dom-0")).toBe(true);
  });

  it("puts the first Access application back when the second cannot move", async () => {
    const w = fakeWorld({ refuse: new Map([["PUT /access/apps/app-health", 500]]) });
    await movedTo(w.world, HOST);
    await accessOn(w.world, HOST);
    await expect(revertManagerAddress(deps(w), {})).rejects.toThrow();
    expect(w.world.apps.map((a) => a.domain)).toEqual([HOST, `${HOST}/api/health`]);
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
  });

  it("does nothing at workers.dev", async () => {
    const w = fakeWorld();
    expect(await revertManagerAddress(deps(w), {})).toEqual({
      wasMoved: false,
      url: null,
      previousDomain: null,
    });
    expect(w.world.calls).toEqual([]);
  });

  it("is refused while a move job runs", async () => {
    const w = fakeWorld();
    await movedTo(w.world, HOST);
    await env.DB.prepare(
      `INSERT INTO jobs (id, kind, status, input_json, workflow_instance_id)
       VALUES ('01RUNNING', 'move_address', 'running', ?1, '01RUNNING')`,
    )
      .bind(JSON.stringify({ hostname: "next.example.com", zoneId: "z-a" }))
      .run();
    await expect(revertManagerAddress(deps(w), {})).rejects.toThrow(
      "Appflare is moving to next.example.com (job 01RUNNING).",
    );
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
    expect(w.world.calls).toEqual([]);
  });
});

describe("reconcileManagerAddress", () => {
  const lazy = (w: ReturnType<typeof fakeWorld>, made: { count: number }) => ({
    db: env.DB,
    now: () => NOW,
    api: async () => {
      made.count++;
      return w.api;
    },
  });

  it("makes no call at workers.dev", async () => {
    const made = { count: 0 };
    expect(await reconcileManagerAddress(lazy(fakeWorld(), made))).toEqual({
      status: "workers-dev",
    });
    expect(made.count).toBe(0);
  });

  it("leaves a domain that still serves the manager alone", async () => {
    const w = fakeWorld();
    await movedTo(w.world, HOST);
    expect(await reconcileManagerAddress(lazy(w, { count: 0 }))).toEqual({
      status: "serving",
      hostname: HOST,
    });
    expect(w.world.calls).toEqual([`GET /workers/domains?service=${WORKER}`]);
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
  });

  it("goes back to workers.dev and notifies when the domain is gone", async () => {
    const w = fakeWorld();
    await movedTo(w.world, HOST);
    await accessOn(w.world, HOST);
    w.world.domains.delete("dom-0");
    await env.DB.prepare(
      `INSERT INTO notification_channels (id, kind, label, target, config, events_json, created_at, updated_at)
       VALUES ('c1', 'webhook', 'Ops', 'example.org', 'v1.x.y', '["manager_address_lost"]', 0, 0)`,
    ).run();
    expect(await reconcileManagerAddress(lazy(w, { count: 0 }))).toEqual({
      status: "lost",
      hostname: HOST,
      notified: 1,
    });
    expect(await addressRows()).toEqual({});
    expect(await setting(SETTING.accessDomain)).toBe(WORKERS_DEV);
    const event = await env.DB.prepare(
      "SELECT type, dedupe_key, facts_json FROM notification_events",
    ).first();
    expect(event).toEqual({
      type: "manager_address_lost",
      dedupe_key: `manager_address_lost:${HOST}:2026-09-01T00:00:00.000Z`,
      facts_json: JSON.stringify({ type: "manager_address_lost", hostname: HOST }),
    });
  });

  it("clears the address even when Access cannot follow", async () => {
    const w = fakeWorld({ refuse: new Map([["PUT /access/apps/app-main", 403]]) });
    await movedTo(w.world, HOST);
    await accessOn(w.world, HOST);
    w.world.domains.delete("dom-0");
    await env.DB.prepare(
      `INSERT INTO notification_channels (id, kind, label, target, config, events_json, created_at, updated_at)
       VALUES ('c1', 'webhook', 'Ops', 'example.org', 'v1.x.y', '["manager_address_lost"]', 0, 0)`,
    ).run();
    expect((await reconcileManagerAddress(lazy(w, { count: 0 }))).status).toBe("lost");
    expect(await addressRows()).toEqual({});
    expect(await setting(SETTING.accessDomain)).toBe(HOST);
    // The message says that sign-in at workers.dev is refused until Access is recovered.
    const event = await env.DB.prepare("SELECT facts_json FROM notification_events").first<{
      facts_json: string;
    }>();
    expect(JSON.parse(event?.facts_json ?? "{}")).toEqual({
      type: "manager_address_lost",
      hostname: HOST,
      accessLeftBehind: true,
    });
  });

  it("changes nothing when Cloudflare's list of domains cannot be read", async () => {
    const w = fakeWorld({ refuse: new Map([["GET /workers/domains", 500]]) });
    await movedTo(w.world, HOST);
    await expect(reconcileManagerAddress(lazy(w, { count: 0 }))).rejects.toThrow();
    expect(await setting(SETTING.managerHostname)).toBe(HOST);
    expect(await setting(SETTING.managerDomainId)).toBe("dom-0");
  });
});

describe("readManagerAddress", () => {
  it("reports the address, whether it serves, and domains attached by hand", async () => {
    const w = fakeWorld();
    await movedTo(w.world, HOST);
    w.world.domains.set("dom-hand", {
      hostname: "manage.beta.dev",
      service: WORKER,
      zone_id: "z-b",
      zone_name: "beta.dev",
    });
    expect(await readManagerAddress(deps(w))).toEqual({
      hostname: HOST,
      zoneId: "z-a",
      previousHostname: WORKERS_DEV,
      movedAt: "2026-09-01T00:00:00.000Z",
      workersDevHostname: WORKERS_DEV,
      serving: true,
      attachedByHand: [
        { hostname: "manage.beta.dev", zoneId: "z-b", zoneName: "beta.dev", leftByMove: false },
      ],
      movingJobId: null,
      movingTo: null,
      pending: null,
    });
    w.world.domains.delete("dom-0");
    expect((await readManagerAddress(deps(w))).serving).toBe(false);
  });

  it("names the move job running, and a domain an earlier move left attached", async () => {
    const w = fakeWorld();
    const d = deps(w);
    await moveManagerAddress(d, { zoneId: "z-a", hostname: HOST });
    const moving = await readManagerAddress(d);
    expect(moving.movingJobId).toBe("01MOVEJOB00000000000000001");
    expect(moving.movingTo).toEqual({ hostname: HOST, zoneId: "z-a" });
    expect(moving.attachedByHand).toEqual([
      { hostname: HOST, zoneId: "z-a", zoneName: "example.com", leftByMove: true },
    ]);

    // Its Workflow instance failed without recording the end: settled, and no longer running.
    const settled = await readManagerAddress({
      ...d,
      workflows: {
        get: async () => ({
          status: async () => ({ status: "errored", error: { message: "engine failure" } }),
        }),
      },
    });
    expect(settled.movingJobId).toBeNull();
    expect(settled.movingTo).toBeNull();
    const job = await env.DB.prepare("SELECT status FROM jobs").first<{ status: string }>();
    expect(job?.status).toBe("failed");
  });
});

describe("listAddressOptions", () => {
  it("suggests appflare.<zone> for every active zone", async () => {
    const w = fakeWorld();
    expect((await listAddressOptions(deps(w))).zones).toEqual([
      { id: "z-b", name: "beta.dev", suggestedHostname: "appflare.beta.dev" },
      { id: "z-a", name: "example.com", suggestedHostname: "appflare.example.com" },
    ]);
  });
});

describe("managerVerdict", () => {
  const version = "0.2.0";
  it("accepts only this manager's health report, and says what answered instead", () => {
    const answer = (status: number, body: string) => ({
      kind: "response" as const,
      status,
      bodyStart: body,
      body,
    });
    expect(managerVerdict(answer(200, '{"version":"0.2.0","db":"ok"}'), version)).toBeNull();
    expect(managerVerdict(answer(200, '{"version":"0.1.0"}'), version)).toBe(
      "Appflare 0.1.0, not 0.2.0",
    );
    expect(managerVerdict(answer(526, "error code: 526"), version)).toBe(
      "HTTP 526, error code 526",
    );
    expect(
      managerVerdict(
        { ...answer(302, ""), location: accessLoginUrl("apps.example.com", "/api/health") },
        version,
      ),
    ).toBe("Cloudflare Access asked for a sign-in");
  });
});

describe("readPasskeyHosts", () => {
  it("names the address of each passkey added at an address Appflare left", async () => {
    await addPasskey("pk-here");
    await addPasskey("pk-old");
    await env.DB.prepare(
      "INSERT INTO passkey_host (passkey_id, hostname, recorded_at) VALUES ('pk-old', ?1, 1)",
    )
      .bind(WORKERS_DEV)
      .run();
    const hosts = await readPasskeyHosts(env.DB, ["pk-here", "pk-old", "pk-gone"]);
    expect([...hosts]).toEqual([["pk-old", WORKERS_DEV]]);
    expect((await readPasskeyHosts(env.DB, [])).size).toBe(0);
  });
});
