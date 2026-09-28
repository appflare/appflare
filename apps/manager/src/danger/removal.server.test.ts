import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { writeAccessConfig } from "../access/config";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import type { GatewayState } from "../gateway/gateway.server";
import { R2_MAX_PAGES_PER_RUN, R2_OBJECTS_PER_STEP } from "../jobs/uninstall";
import { ACC, TOKEN } from "../test/fake-account";
import {
  ACCOUNT_NAME,
  type FakeRemovalOptions,
  fakeRemovalAccount,
  GATEWAY_ZONE_ID,
  GATEWAY_ZONE_NAME,
  MANAGER_WORKER,
  MANAGER_WORKFLOW,
} from "../test/fake-removal";
import { fakeSelf } from "../test/fake-self";
import { deleteManagerWorker, type RemovalStep, runRemoval } from "./removal.server";
import { findRemovalTargets, type RemovalTargets } from "./removal-plan.server";

/**
 * Removing Appflare, against the local D1 and a stateful fake of the
 * account: what is found, the order of the deletes, "already gone" as done,
 * a failure that stops the run, and a second run that finishes it.
 */

const GATEWAY: GatewayState = {
  zoneId: GATEWAY_ZONE_ID,
  zoneName: GATEWAY_ZONE_NAME,
  recordId: "rec-1",
  recordCreated: true,
  fallbackSet: true,
  kvId: "kv-gateway",
  workerUploaded: true,
  routeId: "route-1",
  readyAt: "2026-09-24T12:00:00.000Z",
};

const ACCESS = {
  appId: "access-app",
  policyId: "access-policy",
  healthAppId: "access-health",
  aud: "aud",
  teamDomain: "team.cloudflareaccess.com",
  domain: "appflare.ada.workers.dev",
  enabledAt: "2026-09-24T12:00:00.000Z",
};

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: MANAGER_WORKER,
    [SETTING.externalDomainsGateway]: JSON.stringify(GATEWAY),
  });
  await writeAccessConfig(env.DB, ACCESS);
});

function world(options: FakeRemovalOptions = {}) {
  const account = fakeRemovalAccount(options);
  const api = createClient({ accountId: ACC, token: TOKEN, fetch: account.fetch });
  const self = fakeSelf({ CF_API_TOKEN: TOKEN }, { fetch: account.fetch });
  return { account, api, self };
}

async function run(w: ReturnType<typeof world>, targets?: RemovalTargets) {
  const steps: RemovalStep[] = [];
  const outcome = await runRemoval({
    db: env.DB,
    api: w.api,
    units: { api: w.self, remote: true },
    targets: targets ?? (await findRemovalTargets(env.DB, w.api)),
    emit: async (step) => {
      steps.push(step);
    },
    sleep: async () => {},
  });
  return { outcome, steps };
}

describe("findRemovalTargets", () => {
  it("reads the account name, the manager's D1 and KV, the gateway, the sandbox and Access", async () => {
    const { api, account } = world();
    const targets = await findRemovalTargets(env.DB, api);
    expect(targets).toEqual({
      accountId: ACC,
      accountName: ACCOUNT_NAME,
      manager: {
        workerName: MANAGER_WORKER,
        d1Id: "d1-manager",
        kvId: "kv-manager",
        workflowName: MANAGER_WORKFLOW,
        domain: null,
      },
      gateway: GATEWAY,
      sandbox: {
        worker: "sandbox",
        bucket: true,
        appTokens: 1,
        containerApps: [
          { id: "app-1", name: "appflare-sandbox-standard-1" },
          { id: "app-2", name: "appflare-sandbox-standard-2" },
        ],
      },
      accessAppIds: ["access-health", "access-app"],
    });
    // Six reads, nothing else.
    expect(account.calls).toEqual([
      "GET /a",
      `GET /a/workers/scripts/${MANAGER_WORKER}/bindings`,
      "GET /a/workers/scripts/appflare-sandbox/bindings",
      "GET /a/r2/buckets",
      "GET /a/containers/applications",
      "GET /a/containers/applications",
    ]);
  });

  it("finds no sandbox and no bucket on an account that never enabled R2", async () => {
    const { api } = world({
      sandbox: false,
      containers: "none",
      fail: { "GET /a/r2/buckets": { status: 403, code: 10042, message: "Please enable R2" } },
    });
    const targets = await findRemovalTargets(env.DB, api);
    expect(targets.sandbox).toEqual({
      worker: "missing",
      bucket: false,
      appTokens: 0,
      containerApps: [],
    });
  });
});

describe("runRemoval", () => {
  it("deletes bucket first, then the gateway, the sandbox Worker, KV, D1 and Access last", async () => {
    const w = world({ objects: 3 });
    const before = w.account.calls.length;
    const { outcome, steps } = await run(w);
    expect(outcome).toEqual({ kind: "complete", accessLeft: [], pageLost: false });
    const after = w.account.calls.slice(before + 6);
    expect(after).toEqual([
      "GET /a/r2/buckets/appflare-builds/objects",
      "DELETE /a/r2/buckets/appflare-builds/objects/builds/b0.zip",
      "DELETE /a/r2/buckets/appflare-builds/objects/builds/b1.zip",
      "DELETE /a/r2/buckets/appflare-builds/objects/builds/b2.zip",
      "DELETE /a/r2/buckets/appflare-builds",
      `DELETE /zones/${GATEWAY_ZONE_ID}/workers/routes/route-1`,
      "DELETE /a/workers/scripts/appflare-gateway",
      `GET /zones/${GATEWAY_ZONE_ID}/custom_hostnames/fallback_origin`,
      `DELETE /zones/${GATEWAY_ZONE_ID}/custom_hostnames/fallback_origin`,
      `DELETE /zones/${GATEWAY_ZONE_ID}/dns_records/rec-1`,
      "DELETE /a/storage/kv/namespaces/kv-gateway",
      "DELETE /a/workers/scripts/appflare-sandbox",
      "DELETE /a/containers/applications/app-1",
      "DELETE /a/containers/applications/app-2",
      "DELETE /a/storage/kv/namespaces/kv-manager",
      "DELETE /a/d1/database/d1-manager",
      "DELETE /a/access/apps/access-health",
      "DELETE /a/access/apps/access-app",
    ]);
    // The bucket page ran as a unit over SELF; the manager Worker is not touched here.
    expect(w.self.calls.map((c) => c.unit)).toEqual(["emptyR2Page"]);
    expect(after).not.toContain(`DELETE /a/workers/scripts/${MANAGER_WORKER}`);
    expect(steps.every((s) => s.status === "done")).toBe(true);
    expect(steps.map((s) => s.label)).toContain("Delete the manager's D1 database");
    // The gateway's record goes with its last piece.
    const orm = createDb(env.DB);
    expect(await readSettings(orm, [SETTING.externalDomainsGateway])).toEqual({});
  });

  it("leaves the container applications when the token cannot use Containers", async () => {
    const w = world({ containers: "denied" });
    const targets = await findRemovalTargets(env.DB, w.api);
    expect(targets.sandbox.containerApps).toBeNull();
    const { outcome, steps } = await run(w, targets);
    expect(outcome.kind).toBe("complete");
    expect(w.account.deletes().some((c) => c.includes("/containers/"))).toBe(false);
    expect(steps.some((s) => s.label.includes("container application"))).toBe(false);
  });

  it("empties a larger bucket a page at a time", async () => {
    const w = world({ objects: R2_OBJECTS_PER_STEP + 5 });
    const { outcome, steps } = await run(w);
    expect(outcome.kind).toBe("complete");
    expect(w.self.calls).toHaveLength(2);
    expect(steps.slice(0, 2).map((s) => s.detail)).toEqual([
      `Deleted ${R2_OBJECTS_PER_STEP} objects.`,
      "Deleted 5 objects.",
    ]);
    expect(w.account.remainingObjects()).toBe(0);
  });

  it("stops after a run's page limit, keeping everything else, and the next run continues", async () => {
    const w = world({ objects: R2_OBJECTS_PER_STEP * (R2_MAX_PAGES_PER_RUN + 1) });
    const first = await run(w);
    expect(first.outcome.kind).toBe("failed");
    const failed = first.steps.at(-1);
    expect(failed?.status).toBe("failed");
    expect(failed?.detail).toContain("Run the removal again to continue");
    expect(w.account.deletes()).not.toContain("DELETE /a/r2/buckets/appflare-builds");
    expect(w.account.deletes()).not.toContain("DELETE /a/d1/database/d1-manager");

    const second = await run(w);
    expect(second.outcome.kind).toBe("complete");
    expect(w.account.remainingObjects()).toBe(0);
  });

  it("counts what is already gone as done, and says so", async () => {
    const w = world();
    await run(w);
    // A second run over the same targets: every delete answers 404.
    const again = await run(w, {
      accountId: ACC,
      accountName: ACCOUNT_NAME,
      manager: {
        workerName: MANAGER_WORKER,
        d1Id: "d1-manager",
        kvId: "kv-manager",
        workflowName: MANAGER_WORKFLOW,
      },
      gateway: GATEWAY,
      sandbox: {
        worker: "sandbox",
        bucket: true,
        appTokens: 0,
        containerApps: [
          { id: "app-1", name: "appflare-sandbox-standard-1" },
          { id: "app-2", name: "appflare-sandbox-standard-2" },
        ],
      },
      accessAppIds: ["access-health", "access-app"],
    });
    expect(again.outcome.kind).toBe("complete");
    expect(again.steps.filter((s) => s.label.startsWith("Delete")).map((s) => s.status)).toEqual(
      Array(12).fill("skipped"),
    );
  });

  it("stops at a failed step, keeps the rest, and a second run finishes from there", async () => {
    const dnsDelete = `DELETE /zones/${GATEWAY_ZONE_ID}/dns_records/rec-1`;
    const w = world({ fail: { [dnsDelete]: { status: 403, code: 10000, message: "auth" } } });
    const first = await run(w);
    expect(first.outcome).toMatchObject({
      kind: "failed",
      step: {
        label: `Delete the DNS record appflare-gateway.${GATEWAY_ZONE_NAME}`,
        status: "failed",
      },
    });
    expect(w.account.deletes()).not.toContain("DELETE /a/workers/scripts/appflare-sandbox");
    expect(w.account.deletes()).not.toContain("DELETE /a/d1/database/d1-manager");
    // The removed gateway pieces are recorded, so the next run skips them.
    const saved = await readSettings(createDb(env.DB), [SETTING.externalDomainsGateway]);
    expect(JSON.parse(saved.external_domains_gateway ?? "null")).toMatchObject({
      routeId: null,
      workerUploaded: false,
      fallbackSet: false,
      recordId: "rec-1",
    });

    w.account.heal(dnsDelete);
    const beforeSecond = w.account.calls.length;
    const second = await run(w);
    expect(second.outcome.kind).toBe("complete");
    const secondDeletes = w.account.calls.slice(beforeSecond).filter((c) => c.startsWith("DELETE"));
    expect(secondDeletes).not.toContain(`DELETE /zones/${GATEWAY_ZONE_ID}/workers/routes/route-1`);
    expect(secondDeletes).toContain(dnsDelete);
    expect(secondDeletes.at(-1)).toBe("DELETE /a/access/apps/access-app");
  });

  it("retries the gateway record while its fallback origin is still going", async () => {
    const w = world({ recordBusy: 2 });
    const { outcome } = await run(w);
    expect(outcome.kind).toBe("complete");
    expect(
      w.account.calls.filter((c) => c === `DELETE /zones/${GATEWAY_ZONE_ID}/dns_records/rec-1`),
    ).toHaveLength(3);
  });

  it("stops when the page can no longer be written before the database is deleted", async () => {
    const w = world();
    const targets = await findRemovalTargets(env.DB, w.api);
    let emitted = 0;
    const outcome = await runRemoval({
      db: env.DB,
      api: w.api,
      units: { api: w.self, remote: true },
      targets,
      emit: async () => {
        emitted += 1;
        if (emitted === 2) throw new Error("the stream was closed");
      },
      sleep: async () => {},
    });
    expect(outcome).toEqual({ kind: "page-lost" });
    expect(w.account.deletes()).not.toContain("DELETE /a/d1/database/d1-manager");
    expect(w.account.deletes()).not.toContain("DELETE /a/access/apps/access-app");
  });

  it("carries on once the database is deleted, even when the page is gone", async () => {
    const w = world();
    const targets = await findRemovalTargets(env.DB, w.api);
    let databaseGone = false;
    const outcome = await runRemoval({
      db: env.DB,
      api: w.api,
      units: { api: w.self, remote: true },
      targets,
      emit: async (step) => {
        if (step.label === "Delete the manager's D1 database") databaseGone = true;
        if (databaseGone) throw new Error("the stream was closed");
      },
      sleep: async () => {},
    });
    expect(outcome).toEqual({ kind: "complete", accessLeft: [], pageLost: true });
    expect(w.account.deletes().slice(-2)).toEqual([
      "DELETE /a/access/apps/access-health",
      "DELETE /a/access/apps/access-app",
    ]);
  });

  it("reports an Access application it cannot delete after the database, and still completes", async () => {
    const w = world({
      fail: { "DELETE /a/access/apps/access-app": { status: 403, code: 10000, message: "auth" } },
    });
    const { outcome, steps } = await run(w);
    expect(outcome).toEqual({ kind: "complete", accessLeft: ["access-app"], pageLost: false });
    expect(steps.at(-1)).toMatchObject({ status: "failed" });
    expect(steps.at(-1)?.detail).toContain("Zero Trust, Access, Applications");
  });

  it("leaves Access alone when the KV or D1 step fails", async () => {
    const w = world({
      fail: { "DELETE /a/d1/database/d1-manager": { status: 500, code: 7500, message: "boom" } },
    });
    const { outcome } = await run(w);
    expect(outcome.kind).toBe("failed");
    expect(w.account.deletes().filter((c) => c.includes("/access/apps/"))).toEqual([]);
  });

  it.each([
    ["missing", false],
    ["other", false],
    ["sandbox", true],
  ] as const)(
    "deletes the build bucket only when the sandbox Worker is Appflare's (%s)",
    async (worker, deletes) => {
      const w = world({ objects: 1 });
      const targets = await findRemovalTargets(env.DB, w.api);
      await run(w, {
        ...targets,
        sandbox: { worker, bucket: true, appTokens: 0, containerApps: [] },
      });
      expect(w.account.deletes().includes("DELETE /a/r2/buckets/appflare-builds")).toBe(deletes);
      expect(w.account.remainingObjects()).toBe(deletes ? 0 : 1);
    },
  );
});

describe("findRemovalTargets and Appflare's address", () => {
  it("reads the custom domain Appflare lives on, to detach before the Worker goes", async () => {
    await writeSettings(createDb(env.DB), {
      [SETTING.managerHostname]: "appflare.example.com",
      [SETTING.managerDomainId]: "dom-1",
    });
    const targets = await findRemovalTargets(env.DB, world().api);
    expect(targets.manager.domain).toEqual({
      hostname: "appflare.example.com",
      domainId: "dom-1",
    });
  });
});

describe("deleteManagerWorker", () => {
  const manager = { workerName: MANAGER_WORKER, workflowName: MANAGER_WORKFLOW };

  it("deletes the manager Worker with force, then its Workflow, and treats missing ones as deleted", async () => {
    const w = world();
    expect(await deleteManagerWorker(w.api, manager)).toBe(true);
    expect(await deleteManagerWorker(w.api, manager)).toBe(true);
    const pair = [
      `DELETE /a/workers/scripts/${MANAGER_WORKER}`,
      `DELETE /a/workflows/${MANAGER_WORKFLOW}`,
    ];
    expect(w.account.deletes()).toEqual([...pair, ...pair]);
  });

  it("leaves the Workflow alone when the Worker could not be deleted", async () => {
    const w = world({
      fail: { [`DELETE /a/workers/scripts/${MANAGER_WORKER}`]: { status: 500, code: 10013 } },
    });
    expect(await deleteManagerWorker(w.api, manager)).toBe(false);
    expect(w.account.deletes()).toEqual([`DELETE /a/workers/scripts/${MANAGER_WORKER}`]);
  });

  it("still reports the Worker deleted when its Workflow cannot be deleted", async () => {
    const w = world({
      fail: { [`DELETE /a/workflows/${MANAGER_WORKFLOW}`]: { status: 500, code: 10001 } },
    });
    expect(await deleteManagerWorker(w.api, manager)).toBe(true);
  });

  it("detaches Appflare's custom domain before deleting the Worker", async () => {
    const w = world();
    const domain = { hostname: "appflare.example.com", domainId: "dom-1" };
    expect(await deleteManagerWorker(w.api, { ...manager, domain })).toBe(true);
    expect(w.account.deletes()).toEqual([
      "DELETE /a/workers/domains/dom-1",
      `DELETE /a/workers/scripts/${MANAGER_WORKER}`,
      `DELETE /a/workflows/${MANAGER_WORKFLOW}`,
    ]);
  });

  it("still deletes the Worker when its custom domain cannot be detached", async () => {
    const w = world({
      fail: { "DELETE /a/workers/domains/dom-1": { status: 500, code: 10013 } },
    });
    const domain = { hostname: "appflare.example.com", domainId: "dom-1" };
    expect(await deleteManagerWorker(w.api, { ...manager, domain })).toBe(true);
    expect(w.account.deletes()).toContain(`DELETE /a/workers/scripts/${MANAGER_WORKER}`);
  });

  it("deletes no Workflow when the manager runs none of its own", async () => {
    const w = world();
    expect(await deleteManagerWorker(w.api, { ...manager, workflowName: null })).toBe(true);
    expect(w.account.deletes()).toEqual([`DELETE /a/workers/scripts/${MANAGER_WORKER}`]);
  });
});
