import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthSession } from "../auth/guards";
import { readCapabilityRowsData } from "../capabilities/capability-rows.server";
import { manifestCacheKey } from "../catalog/app-manifest.server";
import { readCatalogEntry } from "../catalog/catalog-entry.server";
import { readCatalogList } from "../catalog/catalog-list.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { ACC, fakeAccount, TOKEN } from "../test/fake-account";
import { fakeSandbox } from "../test/fake-sandbox";
import { DANGLING_SANDBOX } from "../test/fake-sandbox-account";
import { cacheIndex } from "../test/seed-install";
import { readSandboxCardState } from "./card-state.server";
import { readSandboxConnection } from "./connection.server";
import { readSandboxReadiness } from "./readiness.server";
import {
  clearSandboxWorkerDeleted,
  markSandboxWorkerDeleted,
  recordSandboxCheck,
  sandboxBound,
} from "./worker-deleted";

/**
 * The record of a `SANDBOX` binding left pointing at a deleted sandbox
 * Worker: what sets and clears it, and the readers that show sandbox builds
 * as off while it is there.
 */

const SERVING = "11111111-2222-4333-8444-555555555555";
const T1 = new Date("2026-10-06T10:00:00.000Z");
const T2 = new Date("2026-10-06T11:00:00.000Z");

const db = () => createDb(env.DB);
const recorded = async () =>
  (await readSettings(db(), [SETTING.sandboxWorkerDeleted])).sandbox_worker_deleted;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(db(), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: "appflare",
    // Workers Paid with R2 and Containers: sandbox builds turn on at first need.
    [SETTING.accountCapabilities]: JSON.stringify({
      checkedAt: "2026-09-25T12:00:00.000Z",
      r2: { state: "enabled" },
      containers: { state: "available" },
      workersPlan: { state: "paid" },
    }),
  });
});

/** The API client, with the serving version of Appflare's Worker binding `serving`. */
function client(serving: unknown[]) {
  const account = fakeAccount(null, {
    worker: "appflare",
    deployments: [{ id: "dep-0", versions: [{ version_id: SERVING, percentage: 100 }] }],
    versionBindings: { [SERVING]: serving },
  });
  return async () => createClient({ accountId: ACC, token: TOKEN, fetch: account.fetch });
}

/** A binding whose calls fail, as one to a deleted Worker does. */
const lost = {
  info: async () => {
    throw new Error("Network connection lost.");
  },
};

describe("the record itself", () => {
  it("keeps the time it was first found, and clearing a missing one is harmless", async () => {
    await clearSandboxWorkerDeleted(db());
    expect(await recorded()).toBeUndefined();
    await markSandboxWorkerDeleted(db(), T1);
    await markSandboxWorkerDeleted(db(), T2);
    expect(await recorded()).toBe(T1.toISOString());
    await clearSandboxWorkerDeleted(db());
    expect(await recorded()).toBeUndefined();
  });

  it("counts a binding as bound only while no deleted Worker is recorded", async () => {
    expect(await sandboxBound({}, db())).toBe(false);
    expect(await sandboxBound({ SANDBOX: {} }, db())).toBe(true);
    await markSandboxWorkerDeleted(db(), T1);
    expect(await sandboxBound({ SANDBOX: {} }, db())).toBe(false);
    // Without a binding there is nothing to be bound, recorded or not.
    expect(await sandboxBound({}, db())).toBe(false);
  });

  it("follows what a live check found, and leaves it when the check could not tell", async () => {
    await recordSandboxCheck(db(), { danglingBinding: true, answered: false }, T1);
    expect(await recorded()).toBe(T1.toISOString());
    // Not answering, not known to dangle: unchanged.
    await recordSandboxCheck(db(), { danglingBinding: false, answered: false }, T2);
    expect(await recorded()).toBe(T1.toISOString());
    await recordSandboxCheck(db(), { danglingBinding: false, answered: true }, T2);
    expect(await recorded()).toBeUndefined();
  });
});

describe("readSandboxConnection", () => {
  it("records a binding found pointing at a deleted Worker, as a manager updated from before the record finds it", async () => {
    const found = await readSandboxConnection(
      { DB: env.DB, SANDBOX: lost },
      client([DANGLING_SANDBOX]),
    );
    expect(found.connected).toBe(false);
    expect(await recorded()).toBeDefined();
    // The pages then read sandbox builds as off, with no API call.
    expect((await readSandboxReadiness({ DB: env.DB, SANDBOX: lost }, db())).state).toBe(
      "ready-auto",
    );
  });

  it("clears the record once the sandbox Worker answers through the binding", async () => {
    await markSandboxWorkerDeleted(db(), T1);
    const binding = fakeSandbox(await buildArtifactFixture());
    const found = await readSandboxConnection(
      { DB: env.DB, SANDBOX: binding },
      client([{ type: "service", name: "SANDBOX", service: "appflare-sandbox" }]),
    );
    expect(found.connected).toBe(true);
    expect(await recorded()).toBeUndefined();
    expect((await readSandboxReadiness({ DB: env.DB, SANDBOX: binding }, db())).state).toBe("on");
  });

  it("clears the record when the sandbox Worker answers with an answer of another shape", async () => {
    await markSandboxWorkerDeleted(db(), T1);
    const binding = fakeSandbox(await buildArtifactFixture(), {
      info: {
        protocol: 2,
        sandboxVersion: "1.0.0",
        image: "docker.io/mendylanda/appflare-sandbox:1.0.0",
      },
    });
    const found = await readSandboxConnection(
      { DB: env.DB, SANDBOX: binding },
      client([{ type: "service", name: "SANDBOX", service: "appflare-sandbox" }]),
    );
    // It answered, so the Worker it names exists, usable or not.
    expect(found.connected).toBe(true);
    expect(await recorded()).toBeUndefined();
  });

  it("leaves the record alone when the binding fails and the API says it is not dangling", async () => {
    await markSandboxWorkerDeleted(db(), T1);
    await readSandboxConnection(
      { DB: env.DB, SANDBOX: lost },
      client([{ type: "service", name: "SANDBOX", service: "appflare-sandbox" }]),
    );
    expect(await recorded()).toBe(T1.toISOString());
  });
});

describe("Building apps' state", () => {
  it("records a binding found pointing at a deleted Worker before it reads the readiness it shows", async () => {
    const state = await readSandboxCardState(
      { DB: env.DB, SANDBOX: lost },
      { admin: true, client: client([DANGLING_SANDBOX]) },
    );
    expect(state.danglingBinding).toBe(true);
    expect(await recorded()).toBeDefined();
    // The same answer already reads it as off.
    expect(state.readiness.state).toBe("ready-auto");
  });

  it("clears the record before it reads the readiness once the sandbox Worker answers", async () => {
    await markSandboxWorkerDeleted(db(), T1);
    const state = await readSandboxCardState(
      { DB: env.DB, SANDBOX: fakeSandbox(await buildArtifactFixture()) },
      { admin: false, client: client([]) },
    );
    expect(state.connected).toBe(true);
    expect(await recorded()).toBeUndefined();
    expect(state.readiness.state).toBe("on");
  });
});

describe("the readiness readers", () => {
  it("read a binding recorded as dangling as off, so an install turns sandbox builds on first", async () => {
    const withBinding = { DB: env.DB, SANDBOX: {} };
    expect((await readSandboxReadiness(withBinding, db())).state).toBe("on");
    await markSandboxWorkerDeleted(db(), T1);
    expect(await readSandboxReadiness(withBinding, db())).toEqual({
      state: "ready-auto",
      missing: null,
      confirmed: true,
    });
    await clearSandboxWorkerDeleted(db());
    expect((await readSandboxReadiness(withBinding, db())).state).toBe("on");
  });

  it("Your account's capability rows read the same", async () => {
    const withBinding = { DB: env.DB, KV: env.KV, SANDBOX: {} };
    expect((await readCapabilityRowsData(withBinding, db())).sandbox).toBe("enabled");
    await markSandboxWorkerDeleted(db(), T1);
    expect((await readCapabilityRowsData(withBinding, db())).sandbox).toBe("off");
  });
});

describe("the catalog pages", () => {
  const member: AuthSession = {
    user: { id: "u1", email: "m@example.com", name: "M", role: "member" },
    session: { id: "s1", expiresAt: new Date("2099-01-01T00:00:00.000Z") },
  };
  const mutableEnv = env as unknown as Record<string, unknown>;

  beforeEach(async () => {
    const fixture = await buildArtifactFixture();
    await cacheIndex(fixture);
    await env.KV.put(
      manifestCacheKey(fixture.digest),
      new TextDecoder().decode(fixture.manifestBytes),
    );
    // The running Worker has its binding; whether it is on is up to the record.
    mutableEnv.SANDBOX = {};
  });

  afterEach(() => {
    delete mutableEnv.SANDBOX;
  });

  it("the catalog reads a binding recorded as dangling as off", async () => {
    expect((await readCatalogList(member)).sandbox.state).toBe("on");
    await markSandboxWorkerDeleted(db(), T1);
    expect((await readCatalogList(member)).sandbox.state).toBe("ready-auto");
  });

  it("an app's page reads it as off too, so its install form says sandbox builds are turned on first", async () => {
    const before = await readCatalogEntry("cut", async () => member);
    expect(before.sandboxConnected).toBe(true);
    expect(before.sandbox.state).toBe("on");
    await markSandboxWorkerDeleted(db(), T1);
    const after = await readCatalogEntry("cut", async () => member);
    expect(after.sandboxConnected).toBe(false);
    expect(after.sandbox.state).toBe("ready-auto");
  });
});
