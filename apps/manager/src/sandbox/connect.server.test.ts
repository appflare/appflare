import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { buildArtifactFixture } from "../test/artifact-fixture";
import {
  ACC,
  type FakeAccount,
  fakeAccount,
  NEW_VERSION,
  SUBDOMAIN,
  TOKEN,
} from "../test/fake-account";
import { fakeSandbox } from "../test/fake-sandbox";
import { connectSandboxCore, readSandboxStatus } from "./connect.server";

/**
 * "Connect sandbox builds" against the stateful fake account: a new version
 * from the latest one with only `SANDBOX` added, checked on its preview,
 * then deployed.
 */

const SERVING = "11111111-2222-4333-8444-555555555555";
const VERSION = "0.4.0";
const healthy = (version = VERSION) => ({
  status: 200,
  body: JSON.stringify({ version, db: "ok" }),
});

async function connect(
  world: Partial<FakeAccount> = {},
  /** Reuse the account an earlier attempt changed. */
  existing?: ReturnType<typeof fakeAccount>,
) {
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: "appflare",
    [SETTING.accountSubdomain]: SUBDOMAIN,
  });
  const account =
    existing ??
    fakeAccount(null, {
      worker: "appflare",
      otherScripts: ["appflare-sandbox"],
      deployments: [{ id: "dep-0", versions: [{ version_id: SERVING, percentage: 100 }] }],
      previews: [{ status: 404, body: "error code: 1042" }, healthy()],
      ...world,
    });
  const sleeps: number[] = [];
  let error: unknown = null;
  let result: Awaited<ReturnType<typeof connectSandboxCore>> | null = null;
  try {
    result = await connectSandboxCore({
      db: env.DB,
      client: createClient({ accountId: ACC, token: TOKEN, fetch: account.fetch }),
      currentVersion: VERSION,
      fetch: account.fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
  } catch (e) {
    error = e;
  }
  return { account, result, error, sleeps };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("connectSandboxCore", () => {
  it("patches the latest version with SANDBOX only, checks its preview, then deploys it", async () => {
    const r = await connect();
    expect(r.error).toBeNull();
    expect(r.result).toEqual({ alreadyConnected: false, versionId: NEW_VERSION });
    expect(r.account.state.versionPatches).toEqual([
      {
        env: {
          SANDBOX: { type: "service", service: "appflare-sandbox", entrypoint: "SandboxBuilds" },
        },
        annotations: {
          "workers/message": "Appflare: connect sandbox builds",
          "workers/tag": SERVING,
        },
      },
    ]);
    expect(r.account.state.previewHosts).toEqual([
      `${NEW_VERSION.slice(0, 8)}-appflare.${SUBDOMAIN}.workers.dev`,
      `${NEW_VERSION.slice(0, 8)}-appflare.${SUBDOMAIN}.workers.dev`,
    ]);
    expect(r.sleeps).toEqual([2000]);
    expect(r.account.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
    const calls = r.account.state.calls;
    expect(calls.indexOf("PATCH /workers/workers/appflare/versions/latest")).toBeLessThan(
      calls.indexOf("POST /workers/scripts/appflare/deployments"),
    );
  });

  it("refuses when the account has no sandbox Worker, and changes nothing", async () => {
    const r = await connect({ otherScripts: [] });
    expect(String(r.error)).toMatch(
      /There is no sandbox Worker .*npx @appflare\/cli sandbox enable/,
    );
    expect(r.account.state.versionPatches).toEqual([]);
  });

  it("does nothing when the Worker already has SANDBOX", async () => {
    const r = await connect({
      bindings: [{ type: "service", name: "SANDBOX", service: "appflare-sandbox" }],
    });
    expect(r.result).toEqual({ alreadyConnected: true, versionId: null });
    expect(r.account.state.versionPatches).toEqual([]);
  });

  it("refuses a SANDBOX binding to another Worker", async () => {
    const r = await connect({
      bindings: [{ type: "service", name: "SANDBOX", service: "billing" }],
    });
    expect(String(r.error)).toMatch(/already has a service binding named SANDBOX to "billing"/);
    expect(r.account.state.versionPatches).toEqual([]);
  });

  it("refuses when a newer version was uploaded but is not deployed", async () => {
    const r = await connect({ versions: [{ id: "pending-version", metadata: {}, modules: [] }] });
    expect(String(r.error)).toMatch(
      /newest uploaded version .*pending-version.* is not the one serving/,
    );
    expect(r.account.state.versionPatches).toEqual([]);
  });

  it("lets a retry build on a failed earlier attempt, and only on one made from the serving version", async () => {
    const failed = await connect({ previews: [healthy("0.3.0")] });
    expect(failed.error).not.toBeNull();
    // The failed attempt is now the newest version and does not serve.
    failed.account.state.previews = [healthy()];
    const retry = await connect({}, failed.account);
    expect(retry.error).toBeNull();
    expect(retry.account.state.versionPatches).toHaveLength(2);
    expect(retry.account.state.deployments[0]?.versions[0]?.version_id).toBe(
      retry.result?.versionId,
    );

    const foreign = await connect({
      versions: [
        {
          id: "attempt-from-elsewhere",
          metadata: {},
          modules: [],
          annotations: {
            "workers/message": "Appflare: connect sandbox builds",
            "workers/tag": "another-version",
          },
        },
      ],
    });
    expect(String(foreign.error)).toMatch(/attempt-from-elsewhere.* is not the one serving/);
  });

  it("never deploys a version whose preview does not answer as this Appflare", async () => {
    const r = await connect({ previews: [healthy("0.3.0")] });
    expect(String(r.error)).toMatch(/did not pass its check .*reports version 0.3.0/);
    expect(r.account.state.calls).not.toContain("POST /workers/scripts/appflare/deployments");
  });
});

describe("readSandboxStatus", () => {
  it("reports a connected sandbox Worker with its version and image", async () => {
    const binding = fakeSandbox(await buildArtifactFixture());
    const status = await readSandboxStatus({ binding });
    expect(status).toEqual({
      connected: true,
      info: {
        protocol: 1,
        sandboxVersion: "0.4.0",
        image: "docker.io/appflare/sandbox:0.4.0",
        features: ["self-deploying"],
      },
      problem: null,
      workerExists: null,
    });
  });

  it("reports a sandbox Worker that speaks another protocol", async () => {
    const binding = fakeSandbox(await buildArtifactFixture(), {
      info: { protocol: 2, sandboxVersion: "1.0.0", image: "docker.io/appflare/sandbox:1.0.0" },
    });
    const status = await readSandboxStatus({ binding });
    expect(status.connected).toBe(true);
    expect(status.problem).toMatch(/speaks protocol 2, this manager speaks 1; update Appflare/);
  });

  it("tells whether the sandbox Worker exists when not connected", async () => {
    expect(
      await readSandboxStatus({
        binding: undefined,
        listWorkers: async () => ["appflare-sandbox"],
      }),
    ).toMatchObject({ connected: false, workerExists: true });
    expect(await readSandboxStatus({ binding: undefined })).toMatchObject({ workerExists: null });
  });
});
