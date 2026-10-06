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
import { DANGLING_SANDBOX } from "../test/fake-sandbox-account";
import type { SandboxBuildsBinding } from "./binding";
import {
  changeSandboxBinding,
  connectSandboxCore,
  readSandboxStatus,
  sandboxBindingDangles,
} from "./connect.server";

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
      versionBindings: { [SERVING]: [{ type: "d1", name: "DB", id: "db-1" }] },
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
    // Appflare keeps its own workers.dev URL; previews are on for the check.
    expect(r.account.state.subdomainCalls).toEqual([{ enabled: true, previews_enabled: true }]);
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
      /There is no sandbox Worker .*\[the Building apps settings\]\(\/settings\/building#sandbox\)/,
    );
    expect(r.account.state.versionPatches).toEqual([]);
  });

  it("does nothing when the Worker already has SANDBOX", async () => {
    const r = await connect({
      versionBindings: {
        [SERVING]: [{ type: "service", name: "SANDBOX", service: "appflare-sandbox" }],
      },
    });
    expect(r.result).toEqual({ alreadyConnected: true, versionId: null });
    expect(r.account.state.versionPatches).toEqual([]);
  });

  it("replaces a SANDBOX binding to a deleted Worker instead of refusing it", async () => {
    const r = await connect({
      versionBindings: { [SERVING]: [{ type: "d1", name: "DB", id: "db-1" }, DANGLING_SANDBOX] },
    });
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
    expect(r.account.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
  });

  it("refuses a SANDBOX binding to another Worker", async () => {
    const r = await connect({
      versionBindings: { [SERVING]: [{ type: "service", name: "SANDBOX", service: "billing" }] },
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

  it("reads the serving version's bindings, not the newest upload's, so a retry after a failed check connects", async () => {
    // After a connect whose preview check failed, Cloudflare's script-level
    // bindings (the newest upload) show SANDBOX while the serving version has
    // none. Deciding from those said "already connected" and deployed nothing.
    const failed = await connect({ previews: [healthy("0.3.0")] });
    expect(failed.error).not.toBeNull();
    failed.account.state.bindings = [
      { type: "service", name: "SANDBOX", service: "appflare-sandbox" },
    ];
    failed.account.state.previews = [healthy()];
    const retry = await connect({}, failed.account);
    expect(retry.error).toBeNull();
    expect(retry.result?.alreadyConnected).toBe(false);
    expect(retry.account.state.calls).toContain(
      `GET /workers/scripts/appflare/versions/${SERVING}`,
    );
    expect(retry.account.state.calls).not.toContain("GET /workers/scripts/appflare/bindings");
    expect(retry.account.state.deployments[0]?.versions).toEqual([
      { version_id: retry.result?.versionId, percentage: 100 },
    ]);
  });

  it("never deploys a version whose preview does not answer as this Appflare", async () => {
    const r = await connect({ previews: [healthy("0.3.0")] });
    expect(String(r.error)).toMatch(/did not pass its check .*reports version 0.3.0/);
    expect(r.account.state.calls).not.toContain("POST /workers/scripts/appflare/deployments");
  });
});

describe("changeSandboxBinding (disconnect)", () => {
  function world(serving: unknown[]) {
    return fakeAccount(null, {
      worker: "appflare",
      deployments: [{ id: "dep-0", versions: [{ version_id: SERVING, percentage: 100 }] }],
      versionBindings: { [SERVING]: serving },
      previews: [healthy()],
    });
  }
  const disconnect = (account: ReturnType<typeof fakeAccount>) =>
    changeSandboxBinding(
      {
        client: createClient({ accountId: ACC, token: TOKEN, fetch: account.fetch }),
        workerName: "appflare",
        subdomain: SUBDOMAIN,
        currentVersion: VERSION,
        fetch: account.fetch,
        sleep: async () => {},
      },
      false,
    );

  it("removes SANDBOX with a null merge patch, checks the preview, then deploys", async () => {
    const account = world([{ type: "service", name: "SANDBOX", service: "appflare-sandbox" }]);
    const result = await disconnect(account);
    expect(result).toEqual({ unchanged: false, versionId: NEW_VERSION });
    expect(account.state.versionPatches).toEqual([
      {
        env: { SANDBOX: null },
        annotations: {
          "workers/message": "Appflare: disconnect sandbox builds",
          "workers/tag": SERVING,
        },
      },
    ]);
    // The sandbox Worker need not exist any more.
    expect(account.state.calls).not.toContain("GET /workers/scripts");
    expect(account.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
  });

  it("removes a SANDBOX binding to a deleted Worker, as deleting the sandbox Worker leaves it", async () => {
    const account = world([DANGLING_SANDBOX]);
    expect(await disconnect(account)).toEqual({ unchanged: false, versionId: NEW_VERSION });
    expect(account.state.versionPatches).toEqual([
      {
        env: { SANDBOX: null },
        annotations: {
          "workers/message": "Appflare: disconnect sandbox builds",
          "workers/tag": SERVING,
        },
      },
    ]);
    expect(account.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
  });

  it("changes nothing when the serving version has no SANDBOX of Appflare's", async () => {
    for (const serving of [[], [{ type: "service", name: "SANDBOX", service: "billing" }]]) {
      const account = world(serving);
      expect(await disconnect(account)).toEqual({ unchanged: true, versionId: null });
      expect(account.state.versionPatches).toEqual([]);
    }
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
        image: "docker.io/mendylanda/appflare-sandbox:0.4.0",
        features: [
          "self-deploying",
          "repository-builds",
          "github-tokens",
          "install-dirs",
          "config-patch",
          "assets-only",
          "build-env",
        ],
      },
      problem: null,
      workerExists: null,
      danglingBinding: false,
    });
  });

  it("reports a sandbox Worker that speaks another protocol", async () => {
    const binding = fakeSandbox(await buildArtifactFixture(), {
      info: {
        protocol: 2,
        sandboxVersion: "1.0.0",
        image: "docker.io/mendylanda/appflare-sandbox:1.0.0",
      },
    });
    // It answered, so its Worker is there: no need to read the bindings.
    let asked = false;
    const status = await readSandboxStatus({
      binding,
      bindingDangles: async () => {
        asked = true;
        return true;
      },
    });
    expect(asked).toBe(false);
    expect(status.connected).toBe(true);
    expect(status.problem).toMatch(/speaks protocol 2, this manager speaks 1; update Appflare/);
  });

  /** A binding whose calls fail, as one to a deleted Worker does. */
  const lost = {
    info: async () => {
      throw new Error("Network connection lost.");
    },
  } as unknown as SandboxBuildsBinding;

  it("reads a binding to a deleted Worker as off, for admins, and says whether a sandbox Worker exists", async () => {
    expect(
      await readSandboxStatus({
        binding: lost,
        listWorkers: async () => ["appflare"],
        bindingDangles: async () => true,
      }),
    ).toEqual({
      connected: false,
      info: null,
      problem: null,
      workerExists: false,
      danglingBinding: true,
    });
  });

  it("reports a binding that does not answer as connected with its problem otherwise", async () => {
    const notAnswering = {
      connected: true,
      info: null,
      problem: "Network connection lost.",
      workerExists: null,
      danglingBinding: false,
    };
    // The sandbox Worker is there but does not answer.
    expect(await readSandboxStatus({ binding: lost, bindingDangles: async () => false })).toEqual(
      notAnswering,
    );
    // Could not tell.
    expect(
      await readSandboxStatus({
        binding: lost,
        bindingDangles: async () => {
          throw new Error("API down");
        },
      }),
    ).toEqual(notAnswering);
    // Members: no Cloudflare call.
    expect(await readSandboxStatus({ binding: lost })).toEqual(notAnswering);
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

describe("sandboxBindingDangles", () => {
  it("is true only when the serving version binds SANDBOX to a deleted Worker", async () => {
    const dangles = (serving: unknown[]) => {
      const account = fakeAccount(null, {
        worker: "appflare",
        deployments: [{ id: "dep-0", versions: [{ version_id: SERVING, percentage: 100 }] }],
        versionBindings: { [SERVING]: serving },
      });
      return sandboxBindingDangles(
        createClient({ accountId: ACC, token: TOKEN, fetch: account.fetch }),
        "appflare",
      );
    };
    expect(await dangles([DANGLING_SANDBOX])).toBe(true);
    expect(await dangles([{ type: "service", name: "SANDBOX", service: "appflare-sandbox" }])).toBe(
      false,
    );
    expect(await dangles([])).toBe(false);
  });
});
