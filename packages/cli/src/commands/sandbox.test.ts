import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactManifest } from "@appflare/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../context.ts";
import { buildSandboxWranglerConfig, explainSandboxDeployFailure } from "../sandbox-config.ts";
import {
  buildFixtureArtifact,
  type FakeHandler,
  fakeSpawner,
  fakeUi,
  LOGGED_IN,
  makeTestKey,
  type TestKey,
} from "../test-fixtures.ts";
import { sandboxDisable, sandboxEnable } from "./sandbox.ts";

const NOT_FOUND = { code: 1, stderr: "This Worker does not exist on your account. [code: 10007]" };
const TOKEN = "oauth-secret-token";

/** Reshapes the fixture artifact into a sandbox Worker artifact. */
function asSandboxWorker(m: ArtifactManifest): void {
  m.app = "appflare-sandbox";
  m.worker.name = "appflare-sandbox";
  m.worker.compatibilityFlags = ["nodejs_compat"];
  m.worker.modules = m.worker.modules.slice(0, 1);
  m.worker.bindings = [
    { type: "r2_bucket", name: "BUILDS" },
    { type: "durable_object_namespace", name: "Sandbox", class_name: "Sandbox" },
    { type: "durable_object_namespace", name: "LargeSandbox", class_name: "LargeSandbox" },
    { type: "plain_text", name: "APPFLARE_VERSION", text: m.version },
  ];
  m.worker.migrations = [{ tag: "v1", new_sqlite_classes: ["Sandbox", "LargeSandbox"] }];
  m.worker.crons = [];
  m.assets = { config: {}, binding: null, files: [] };
  m.d1Migrations = {};
}

const sandboxWorkerBindings = [
  { type: "plain_text", name: "APPFLARE_VERSION", text: "0.0.9" },
  { type: "durable_object_namespace", name: "Sandbox", class_name: "Sandbox" },
  { type: "r2_bucket", name: "BUILDS", bucket_name: "appflare-builds" },
];
const deployed = (bindings: unknown[]) => ({
  "deployments list": () => ({
    stdout: JSON.stringify([
      {
        id: "d1",
        created_on: "2026-09-20T00:00:00Z",
        versions: [{ version_id: "v-1", percentage: 100 }],
      },
    ]),
  }),
  "versions view": () => ({
    stdout: JSON.stringify({
      id: "v-1",
      metadata: { created_on: "2026-09-20T00:00:00Z" },
      resources: { bindings },
    }),
  }),
});

let tmpRoot: string;
let key: TestKey;
let artifactDir: string;
beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "appflare-cli-sandbox-"));
  key = await makeTestKey();
  artifactDir = (
    await buildFixtureArtifact({ sign: key, version: "0.1.0", mutate: asSandboxWorker })
  ).dir;
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(artifactDir, { recursive: true, force: true });
});

function setup(overrides: Record<string, FakeHandler> = {}, ui = fakeUi()) {
  let deployedConfig: Record<string, unknown> | undefined;
  const fake = fakeSpawner({
    whoami: () => ({ stdout: LOGGED_IN }),
    "deployments list": () => NOT_FOUND,
    deploy: (call) => {
      const configPath = call.args[call.args.indexOf("--config") + 1] as string;
      deployedConfig = JSON.parse(readFileSync(configPath, "utf8"));
      return {};
    },
    delete: () => ({}),
    "containers delete": () => ({}),
    "r2 bucket": () => ({}),
    auth: () => ({ stdout: JSON.stringify({ type: "oauth", token: TOKEN }) }),
    ...overrides,
  });
  const requests: { method: string; url: string; auth: string | null }[] = [];
  const ctx: CommandContext = {
    ui: ui.ui,
    env: {},
    fetch: async (url, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url,
        auth: new Headers(init?.headers).get("authorization"),
      });
      if (url.includes("/containers/applications?name=")) {
        // The server filters by name loosely; only exact names may be deleted.
        const name = decodeURIComponent(url.split("name=")[1] ?? "");
        return Response.json(
          name === "appflare-sandbox-standard-1"
            ? [
                { id: "11111111-1111-1111-1111-111111111111", name },
                { id: "22222222-2222-2222-2222-222222222222", name: `${name}-other` },
              ]
            : { success: true, result: [] },
        );
      }
      if (url.includes("/objects?prefix=")) {
        return Response.json({
          success: true,
          errors: [],
          result: { id: "job-1", status: "ENQUEUED", prefixDelete: { deletedObjects: 0 } },
        });
      }
      if (url.endsWith("/jobs/job-1")) {
        return Response.json({
          success: true,
          errors: [],
          result: { id: "job-1", status: "COMPLETED", prefixDelete: { deletedObjects: 7 } },
        });
      }
      return new Response("unexpected", { status: 500 });
    },
    spawner: fake.spawner,
    wranglerBin: "/fake/wrangler.js",
    tmpRoot,
    keys: [key.key],
    sleep: async () => {},
  };
  return { ctx, calls: fake.calls, ui, requests, config: () => deployedConfig };
}

const commands = (calls: { args: string[] }[]) => calls.map((c) => c.args.slice(0, 2).join(" "));

describe("sandbox enable", () => {
  it("deploys the verified sandbox Worker from a generated config with Containers, the Sandbox classes, and the bucket", async () => {
    const t = setup();
    await sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx);

    expect(commands(t.calls)).toEqual(["whoami --json", "deployments list", "deploy --config"]);
    const deploy = t.calls.at(-1);
    expect(deploy?.args).toContain("--strict");
    expect(deploy?.output).toBe("tee");
    expect(deploy?.env.CLOUDFLARE_ACCOUNT_ID).toBe("acc-1");
    expect(t.config()).toMatchObject({
      name: "appflare-sandbox",
      main: "worker/index.js",
      workers_dev: false,
      preview_urls: false,
      compatibility_flags: ["nodejs_compat"],
      containers: [
        {
          name: "appflare-sandbox-standard-1",
          class_name: "Sandbox",
          image: "docker.io/mendylanda/appflare-sandbox:0.1.0",
          instance_type: "standard-1",
        },
        {
          name: "appflare-sandbox-standard-2",
          class_name: "LargeSandbox",
          image: "docker.io/mendylanda/appflare-sandbox:0.1.0",
          instance_type: "standard-2",
        },
      ],
      durable_objects: {
        bindings: [
          { name: "Sandbox", class_name: "Sandbox" },
          { name: "LargeSandbox", class_name: "LargeSandbox" },
        ],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Sandbox", "LargeSandbox"] }],
      r2_buckets: [{ binding: "BUILDS", bucket_name: "appflare-builds" }],
      vars: { APPFLARE_VERSION: "0.1.0" },
    });
    expect(JSON.stringify(t.config())).not.toContain("account_id");
    expect(t.ui.results.join("\n")).toContain("US$0.012");
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("downloads the newest sandbox Worker release, never a manager release", async () => {
    const t = setup();
    const files = Object.fromEntries(
      readdirSync(artifactDir).map((f) => [f, readFileSync(path.join(artifactDir, f))]),
    );
    const asset = (name: string) => ({
      name,
      url: `https://api.github.com/repos/appflare/appflare/releases/assets/${name}`,
      size: (files[name] as Buffer).length,
    });
    const sandboxAssets = ["appflare-sandbox-0.1.0.zip", "manifest.json", "manifest.sig"].map(
      asset,
    );
    t.ctx.fetch = async (url) => {
      if (url.endsWith("?per_page=100")) {
        return Response.json([
          { id: 2, tag_name: "manager@0.9.0", draft: false, prerelease: false, assets: [] },
          {
            id: 1,
            tag_name: "sandbox@0.1.0",
            draft: false,
            prerelease: false,
            assets: sandboxAssets,
          },
        ]);
      }
      const name = url.split("/").at(-1) as string;
      return new Response(files[name] as Buffer);
    };
    await sandboxEnable({ yes: true, allowUnsigned: false }, t.ctx);
    expect(t.ui.lines).toContain("  Release sandbox@0.1.0");
    expect(t.config()).toMatchObject({ vars: { APPFLARE_VERSION: "0.1.0" } });
  });

  it("updates an existing sandbox Worker in place", async () => {
    const t = setup(deployed(sandboxWorkerBindings));
    await sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx);
    expect(t.ui.lines).toContain("  Replacing sandbox Worker 0.0.9 with 0.1.0.");
    expect(commands(t.calls)).toContain("deploy --config");
  });

  it("refuses to overwrite a Worker by that name that is not a sandbox Worker", async () => {
    const t = setup(deployed([{ type: "kv_namespace", name: "KV", namespace_id: "x" }]));
    await expect(
      sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx),
    ).rejects.toThrow("is not an Appflare sandbox Worker");
    expect(commands(t.calls)).not.toContain("deploy --config");
  });

  it("refuses a manager artifact", async () => {
    const manager = await buildFixtureArtifact({ sign: key });
    const t = setup();
    await expect(
      sandboxEnable({ artifactDir: manager.dir, yes: true, allowUnsigned: false }, t.ctx),
    ).rejects.toThrow('this artifact is "appflare", not the Appflare sandbox Worker');
    rmSync(manager.dir, { recursive: true, force: true });
  });

  it("says that Sandbox builds need Workers Paid when Cloudflare refuses Containers", async () => {
    const t = setup({
      deploy: () => ({
        code: 1,
        stderr:
          "✘ [ERROR] A request to the Cloudflare API (/accounts/acc-1/containers/image-preparations) failed.\n" +
          "  Container image preparation is not enabled for this account",
      }),
    });
    await expect(
      sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx),
    ).rejects.toThrow(/^Sandbox builds need Workers Paid\./);
  });

  it("keeps wrangler's own error for other failures", async () => {
    const t = setup({ deploy: () => ({ code: 1, stderr: "✘ [ERROR] something else" }) });
    await expect(
      sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx),
    ).rejects.toThrow("`wrangler deploy` failed (exit code 1); see its output above.");
  });
});

describe("sandbox disable", () => {
  it("needs --yes", async () => {
    const t = setup(deployed(sandboxWorkerBindings));
    await expect(
      sandboxDisable({ yes: false, purge: false, iUnderstandDataLoss: false }, t.ctx),
    ).rejects.toThrow("--yes");
    expect(t.calls).toEqual([]);
  });

  it("deletes the Worker and its container applications, and keeps the bucket", async () => {
    const t = setup(deployed(sandboxWorkerBindings));
    await sandboxDisable({ yes: true, purge: false, iUnderstandDataLoss: false }, t.ctx);
    expect(commands(t.calls)).toEqual([
      "whoami --json",
      "deployments list",
      "versions view",
      "delete --name",
      "auth token",
      "containers delete",
    ]);
    expect(t.calls.at(-1)?.args).toEqual([
      "containers",
      "delete",
      "11111111-1111-1111-1111-111111111111",
      "--config",
      expect.any(String),
    ]);
    const summary = t.ui.results.join("\n");
    expect(summary).toContain('Deleted the Worker "appflare-sandbox".');
    expect(summary).toContain("The R2 bucket appflare-builds with build outputs and logs was kept");
    // Looked up by name on the server, not from wrangler's first page of 25.
    expect(t.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://api.cloudflare.com/client/v4/accounts/acc-1/containers/applications?name=appflare-sandbox-standard-1",
      "GET https://api.cloudflare.com/client/v4/accounts/acc-1/containers/applications?name=appflare-sandbox-standard-2",
    ]);
    expect(t.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("refuses a Worker by that name that is not a sandbox Worker", async () => {
    const t = setup(deployed([{ type: "d1", name: "DB", id: "x" }]));
    await expect(
      sandboxDisable({ yes: true, purge: false, iUnderstandDataLoss: false }, t.ctx),
    ).rejects.toThrow("is not an Appflare sandbox Worker");
    expect(commands(t.calls)).not.toContain("delete --name");
  });

  it("with --purge empties the bucket through the API and deletes it, never showing the credential", async () => {
    const t = setup(deployed(sandboxWorkerBindings));
    await sandboxDisable({ yes: true, purge: true, iUnderstandDataLoss: true }, t.ctx);
    expect(t.requests.map((r) => `${r.method} ${r.url}`).slice(2)).toEqual([
      "DELETE https://api.cloudflare.com/client/v4/accounts/acc-1/r2/buckets/appflare-builds/objects?prefix=",
      "GET https://api.cloudflare.com/client/v4/accounts/acc-1/r2/buckets/appflare-builds/jobs/job-1",
    ]);
    expect(t.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(commands(t.calls).at(-1)).toBe("r2 bucket");
    expect(t.calls.at(-1)?.args.slice(0, 4)).toEqual(["r2", "bucket", "delete", "appflare-builds"]);
    const output = [...t.ui.lines, ...t.ui.results].join("\n");
    expect(output).toContain("Deleted the bucket appflare-builds (7 objects).");
    expect(output).not.toContain(TOKEN);
  });

  it("with --purge asks for the name in a terminal, and needs it without one", async () => {
    const t = setup(
      deployed(sandboxWorkerBindings),
      fakeUi({ interactive: true, answers: ["nope"] }),
    );
    await expect(
      sandboxDisable({ yes: true, purge: true, iUnderstandDataLoss: false }, t.ctx),
    ).rejects.toThrow("The name did not match; nothing was deleted.");
    expect(commands(t.calls)).not.toContain("delete --name");

    const headless = setup(deployed(sandboxWorkerBindings));
    await expect(
      sandboxDisable({ yes: true, purge: true, iUnderstandDataLoss: false }, headless.ctx),
    ).rejects.toThrow("--i-understand-data-loss");
  });

  it("reports container applications it could not look up, and still finishes", async () => {
    const t = setup(deployed(sandboxWorkerBindings));
    t.ctx.fetch = async () => new Response("no", { status: 403 });
    await sandboxDisable({ yes: true, purge: false, iUnderstandDataLoss: false }, t.ctx);
    expect(t.ui.results.join("\n")).toContain(
      "Could not look up the container applications appflare-sandbox-standard-1 and appflare-sandbox-standard-2 (listing container applications answered HTTP 403)",
    );
    expect(commands(t.calls)).not.toContain("containers delete");
  });

  it("says so when there is no sandbox Worker to disable", async () => {
    const t = setup();
    await expect(
      sandboxDisable({ yes: true, purge: false, iUnderstandDataLoss: false }, t.ctx),
    ).rejects.toThrow('There is no sandbox Worker ("appflare-sandbox") in this account.');
  });
});

describe("buildSandboxWranglerConfig", () => {
  it("refuses an artifact with a binding this CLI does not know", async () => {
    const fixture = await buildFixtureArtifact({
      mutate: (m) => {
        asSandboxWorker(m);
        m.worker.bindings.push({ type: "kv_namespace", name: "EXTRA" });
      },
    });
    expect(() => buildSandboxWranglerConfig(fixture.manifest)).toThrow(
      "a kv_namespace binding (EXTRA)",
    );
    rmSync(fixture.dir, { recursive: true, force: true });
  });
});

describe("explainSandboxDeployFailure", () => {
  it("recognizes a plan without Containers and an account without R2", () => {
    expect(explainSandboxDeployFailure("Containers are not enabled for this account")).toMatch(
      /^Sandbox builds need Workers Paid/,
    );
    expect(explainSandboxDeployFailure("You need a Workers Paid plan to use this")).toMatch(
      /^Sandbox builds need Workers Paid/,
    );
    expect(
      explainSandboxDeployFailure(
        "Please enable R2 through the Cloudflare Dashboard. [code: 10042]",
      ),
    ).toMatch(/^R2 is not enabled/);
    expect(explainSandboxDeployFailure("Authentication error [code: 10000]")).toBeNull();
  });
});
