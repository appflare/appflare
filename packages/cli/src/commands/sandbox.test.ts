import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactManifest } from "@appflare/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../context.ts";
import {
  buildSandboxWranglerConfig,
  explainSandboxDeployFailure,
  isContainerAccessFailure,
} from "../sandbox-config.ts";
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
const API_TOKEN = { stdout: JSON.stringify({ type: "api_token", token: TOKEN }) };

/** What wrangler 4.136 printed when the Containers API refused an account API token. */
const CONTAINER_STEP_UNAUTHORIZED =
  "Uploaded appflare-sandbox (7.89 sec)\n" +
  "╭ Deploy a container application deploy changes to your application\n" +
  "│\n" +
  "│ Container application changes\n" +
  "│\n" +
  "✘ [ERROR] Unauthorized\n";

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

/** The fake account: whether the build bucket exists, and how the Containers API answers. */
interface FakeAccount {
  bucket: boolean;
  containersStatus: number;
  /** Answer the bucket lookup with a server error. */
  bucketLookupFails?: boolean;
  /** The account's Workers plan, as its subscriptions list it; unreadable when absent. */
  plan?: "free" | "paid";
  /** R2 was never enabled (Cloudflare's code 10042). */
  r2Disabled?: boolean;
}

function setup(
  overrides: Record<string, FakeHandler> = {},
  ui = fakeUi(),
  account: FakeAccount = { bucket: false, containersStatus: 200 },
) {
  let deployedConfig: Record<string, unknown> | undefined;
  const fake = fakeSpawner({
    whoami: () => ({ stdout: LOGGED_IN }),
    "deployments list": () => NOT_FOUND,
    deploy: (call) => {
      const configPath = call.args[call.args.indexOf("--config") + 1] as string;
      deployedConfig = JSON.parse(readFileSync(configPath, "utf8"));
      account.bucket = true;
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
      if (url.endsWith("/r2/buckets/appflare-builds")) {
        if (account.bucketLookupFails) {
          return new Response("upstream error", { status: 502 });
        }
        return account.bucket
          ? Response.json({ success: true, errors: [], result: { name: "appflare-builds" } })
          : Response.json(
              {
                success: false,
                errors: [{ code: 10006, message: "The specified bucket does not exist." }],
                result: null,
              },
              { status: 404 },
            );
      }
      if (url.endsWith("/r2/buckets?per_page=1")) {
        return account.r2Disabled
          ? Response.json(
              {
                success: false,
                errors: [
                  { code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." },
                ],
                result: null,
              },
              { status: 403 },
            )
          : Response.json({ success: true, errors: [], result: { buckets: [] } });
      }
      if (url.includes("/subscriptions?")) {
        if (account.plan === undefined) {
          return Response.json(
            { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
            { status: 403 },
          );
        }
        const plans = account.plan === "paid" ? ["workers_paid", "r2_paid"] : ["free", "r2_paid"];
        return Response.json({
          success: true,
          errors: [],
          result: plans.map((id) => ({ rate_plan: { id }, state: "Paid" })),
          result_info: { page: 1, per_page: 50, total_pages: 1 },
        });
      }
      if (url.includes("/containers/applications?name=") && account.containersStatus !== 200) {
        return Response.json({ success: false }, { status: account.containersStatus });
      }
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
  return { ctx, calls: fake.calls, ui, requests, account, config: () => deployedConfig };
}

const commands = (calls: { args: string[] }[]) => calls.map((c) => c.args.slice(0, 2).join(" "));

describe("sandbox enable", () => {
  it("deploys the verified sandbox Worker from a generated config with Containers, the Sandbox classes, and the bucket", async () => {
    const t = setup();
    await sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx);

    expect(commands(t.calls)).toEqual([
      "whoami --json",
      "auth token",
      "deployments list",
      "deploy --config",
    ]);
    // A `wrangler login` is checked too (R2, Containers, plan), then the bucket is looked up.
    expect(t.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://api.cloudflare.com/client/v4/accounts/acc-1/r2/buckets?per_page=1",
      "GET https://api.cloudflare.com/client/v4/accounts/acc-1/containers/applications?name=appflare-sandbox-standard-1",
      "GET https://api.cloudflare.com/client/v4/accounts/acc-1/subscriptions?page=1&per_page=50",
      "GET https://api.cloudflare.com/client/v4/accounts/acc-1/r2/buckets/appflare-builds",
    ]);
    expect(t.ui.lines).toContain("  The credential can use Containers.");
    // A login without billing access cannot read the subscriptions; Containers answering
    // shows Workers Paid anyway.
    expect(t.ui.lines).toContain("  The account is on Workers Paid.");
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
    expect(t.ui.results.join("\n")).toContain("Settings > Sandbox builds");
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

  it("keeps wrangler's own error for other failures, and removes the new Worker and its container applications", async () => {
    const t = setup({
      deploy: () => ({
        code: 1,
        stdout: "Uploaded appflare-sandbox\n",
        stderr: "✘ [ERROR] something else",
      }),
    });
    const error = await sandboxEnable(
      { artifactDir, yes: true, allowUnsigned: false },
      t.ctx,
    ).catch((e: Error) => e);
    expect(String(error)).toContain(
      "`wrangler deploy` failed (exit code 1); see its output above.",
    );
    expect(String(error)).toContain('Removed the Worker "appflare-sandbox" this run uploaded.');
    expect(commands(t.calls).slice(-4)).toEqual([
      "deploy --config",
      "delete --name",
      "auth token",
      "containers delete",
    ]);
  });

  it("explains a refused container step, and removes the Worker and the empty bucket it created", async () => {
    const t = setup(
      {
        auth: () => API_TOKEN,
        deploy: () => {
          // wrangler creates the bucket and uploads the Worker before the container step.
          t.account.bucket = true;
          t.account.containersStatus = 401;
          return { code: 1, stdout: CONTAINER_STEP_UNAUTHORIZED };
        },
      },
      fakeUi(),
      // The pre-deploy check could not tell (for example a network error), so the deploy ran.
      { bucket: false, containersStatus: 500 },
    );
    const error = await sandboxEnable(
      { artifactDir, yes: true, allowUnsigned: false },
      t.ctx,
    ).catch((e: Error) => e);
    const message = String(error);
    expect(message).toContain("Cloudflare refused access to Containers");
    expect(message).toContain("not on Workers Paid");
    expect(message).toContain("lacks the Containers permission");
    expect(message).toContain('Removed the Worker "appflare-sandbox" this run uploaded.');
    expect(message).toContain("Removed the R2 bucket appflare-builds this run created.");
    expect(message).not.toContain(TOKEN);
    expect(commands(t.calls).slice(-4)).toEqual([
      "deploy --config",
      "delete --name",
      "auth token",
      "r2 bucket",
    ]);
    expect(t.calls.at(-1)?.args.slice(0, 4)).toEqual(["r2", "bucket", "delete", "appflare-builds"]);
    // Container applications are still looked up; the refused lookup is not reported.
    expect(
      t.requests.filter((r) => r.url.includes("/containers/applications")).length,
    ).toBeGreaterThan(1);
    expect(message).not.toContain("Could not look up");
    expect(commands(t.calls)).not.toContain("containers delete");
    // The bucket is only deleted, never emptied.
    expect(t.requests.some((r) => r.url.includes("/objects"))).toBe(false);
  });

  it("keeps a sandbox Worker and a bucket that existed before a failed deploy", async () => {
    const t = setup(
      {
        ...deployed(sandboxWorkerBindings),
        deploy: () => ({ code: 1, stdout: CONTAINER_STEP_UNAUTHORIZED }),
      },
      fakeUi(),
      { bucket: true, containersStatus: 200 },
    );
    const error = await sandboxEnable(
      { artifactDir, yes: true, allowUnsigned: false },
      t.ctx,
    ).catch((e: Error) => e);
    const message = String(error);
    expect(message).toContain("Cloudflare refused access to Containers");
    expect(message).toContain(
      'The Worker "appflare-sandbox" existed before this run and was kept. wrangler had already uploaded 0.1.0 to it, so it may now run that version',
    );
    expect(message).toContain(
      "The R2 bucket appflare-builds existed before this run, so it was kept.",
    );
    expect(commands(t.calls)).not.toContain("delete --name");
    expect(commands(t.calls)).not.toContain("r2 bucket");
    expect(commands(t.calls)).not.toContain("containers delete");
  });

  it("keeps a bucket it could not account for before the deploy", async () => {
    const t = setup(
      {
        deploy: () => ({
          code: 1,
          stdout: "Uploaded appflare-sandbox (1.00 sec)\n",
          stderr: "✘ [ERROR] boom",
        }),
      },
      fakeUi(),
      { bucket: false, containersStatus: 200, bucketLookupFails: true },
    );
    const error = await sandboxEnable(
      { artifactDir, yes: true, allowUnsigned: false },
      t.ctx,
    ).catch((e: Error) => e);
    expect(String(error)).toContain(
      "Could not tell whether the R2 bucket appflare-builds existed before this run, so it was kept",
    );
    expect(commands(t.calls)).not.toContain("r2 bucket");
  });

  it("deletes no Worker when the failed deploy never uploaded one", async () => {
    const t = setup({ deploy: () => ({ code: 1, stderr: "✘ [ERROR] boom before the upload" }) });
    await expect(
      sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx),
    ).rejects.toThrow("`wrangler deploy` failed (exit code 1)");
    expect(commands(t.calls)).not.toContain("delete --name");
    expect(commands(t.calls)).not.toContain("containers delete");
  });

  it("says so when the uploaded Worker is already gone at rollback", async () => {
    const t = setup({
      deploy: () => ({
        code: 1,
        stdout: "Uploaded appflare-sandbox (1.00 sec)\n",
        stderr: "✘ [ERROR] boom",
      }),
      delete: () => NOT_FOUND,
    });
    const error = await sandboxEnable(
      { artifactDir, yes: true, allowUnsigned: false },
      t.ctx,
    ).catch((e: Error) => e);
    expect(String(error)).toContain(
      'The Worker "appflare-sandbox" was already gone; nothing to remove.',
    );
    expect(String(error)).not.toContain("FAILED to remove the Worker");
  });

  it("with a login, stops before deploying when Cloudflare refuses Containers", async () => {
    const t = setup({}, fakeUi(), { bucket: false, containersStatus: 403 });
    const error = await sandboxEnable(
      { artifactDir, yes: true, allowUnsigned: false },
      t.ctx,
    ).catch((e: Error) => e);
    expect(String(error)).toContain("Sandbox builds need Workers Paid");
    expect(String(error)).toContain("Nothing was uploaded.");
    expect(commands(t.calls)).not.toContain("deploy --config");
  });

  it("with an API token, stops before deploying when the token cannot use Containers", async () => {
    const t = setup({ auth: () => API_TOKEN }, fakeUi(), { bucket: false, containersStatus: 401 });
    const error = await sandboxEnable(
      { artifactDir, yes: true, allowUnsigned: false },
      t.ctx,
    ).catch((e: Error) => e);
    const message = String(error);
    expect(message).toContain("two possible causes");
    expect(message).toContain("Account > Containers > Edit");
    expect(message).toContain("Nothing was uploaded.");
    expect(message).not.toContain(TOKEN);
    expect(commands(t.calls)).toEqual(["whoami --json", "auth token"]);
    // Read calls only, all with the credential's bearer token; nothing was created.
    expect(t.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://api.cloudflare.com/client/v4/accounts/acc-1/r2/buckets?per_page=1",
      "GET https://api.cloudflare.com/client/v4/accounts/acc-1/containers/applications?name=appflare-sandbox-standard-1",
      "GET https://api.cloudflare.com/client/v4/accounts/acc-1/subscriptions?page=1&per_page=50",
    ]);
    expect(t.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("stops before deploying when the subscriptions show Workers Free", async () => {
    // Containers could not be checked (a server error), so the subscriptions decide.
    const t = setup({ auth: () => API_TOKEN }, fakeUi(), {
      bucket: false,
      containersStatus: 500,
      plan: "free",
    });
    const message = String(
      await sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx).catch(
        (e: Error) => e,
      ),
    );
    expect(message).toContain("Sandbox builds need Workers Paid.");
    expect(message).toContain("Nothing was uploaded.");
    expect(commands(t.calls)).not.toContain("deploy --config");
  });

  it("stops before deploying when R2 was never enabled", async () => {
    const t = setup({}, fakeUi(), {
      bucket: false,
      containersStatus: 200,
      plan: "paid",
      r2Disabled: true,
    });
    const message = String(
      await sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx).catch(
        (e: Error) => e,
      ),
    );
    expect(message).toContain("R2 is not enabled on this account.");
    expect(commands(t.calls)).not.toContain("deploy --config");
  });

  it("deploys when Containers answer, even if the subscriptions list no Workers entry", async () => {
    const t = setup({}, fakeUi(), { bucket: false, containersStatus: 200, plan: "free" });
    await sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx);
    expect(t.ui.lines).toContain("  The account is on Workers Paid.");
    expect(commands(t.calls)).toContain("deploy --config");
  });

  it("says so when the subscriptions show Workers Paid", async () => {
    const t = setup({}, fakeUi(), { bucket: false, containersStatus: 200, plan: "paid" });
    await sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx);
    expect(t.ui.lines).toContain("  The account is on Workers Paid.");
    expect(commands(t.calls)).toContain("deploy --config");
  });

  it("with an API token that can use Containers, deploys", async () => {
    const t = setup({ auth: () => API_TOKEN });
    await sandboxEnable({ artifactDir, yes: true, allowUnsigned: false }, t.ctx);
    expect(t.ui.lines).toContain("  The credential can use Containers.");
    expect(commands(t.calls)).toContain("deploy --config");
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

  it("does not claim to delete a Worker that was already gone", async () => {
    const t = setup({ ...deployed(sandboxWorkerBindings), delete: () => NOT_FOUND });
    await sandboxDisable({ yes: true, purge: false, iUnderstandDataLoss: false }, t.ctx);
    const summary = t.ui.results.join("\n");
    expect(summary).toContain(
      'The Worker "appflare-sandbox" was already gone; nothing to delete there.',
    );
    expect(summary).not.toContain('Deleted the Worker "appflare-sandbox".');
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
  it("declares the version metadata binding when the artifact has one", async () => {
    const fixture = await buildFixtureArtifact({
      mutate: (m) => {
        asSandboxWorker(m);
        m.worker.bindings.push({ type: "version_metadata", name: "CF_VERSION_METADATA" });
      },
    });
    expect(buildSandboxWranglerConfig(fixture.manifest).version_metadata).toEqual({
      binding: "CF_VERSION_METADATA",
    });
    rmSync(fixture.dir, { recursive: true, force: true });

    const older = await buildFixtureArtifact({ mutate: asSandboxWorker });
    expect(buildSandboxWranglerConfig(older.manifest).version_metadata).toBeUndefined();
    rmSync(older.dir, { recursive: true, force: true });
  });

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

  it("names both causes of a refused container step for an API token, and the plan for a login", () => {
    const forToken = explainSandboxDeployFailure(CONTAINER_STEP_UNAUTHORIZED, { apiToken: true });
    expect(forToken).toContain("two possible causes");
    expect(forToken).toContain("https://dash.cloudflare.com/?to=/:account/workers/plans");
    expect(forToken).toContain("Account > Containers > Edit");
    const forLogin = explainSandboxDeployFailure(CONTAINER_STEP_UNAUTHORIZED, { apiToken: false });
    expect(forLogin).toContain("Sandbox builds need Workers Paid");
    expect(forLogin).not.toContain("CLOUDFLARE_API_TOKEN");
    expect(
      explainSandboxDeployFailure(
        "╭ Deploy a container application deploy changes to your application\n✘ [ERROR] Forbidden",
      ),
    ).toContain("Cloudflare refused access to Containers");
    // "Unauthorized" outside the container step is someone else's failure.
    expect(explainSandboxDeployFailure("✘ [ERROR] Unauthorized")).toBeNull();
    expect(isContainerAccessFailure(CONTAINER_STEP_UNAUTHORIZED)).toBe(true);
    expect(isContainerAccessFailure("Uploaded appflare-sandbox\n✘ [ERROR] something else")).toBe(
      false,
    );
  });
});
