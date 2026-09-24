import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../context.ts";
import { CliTelemetry } from "../telemetry.ts";
import {
  buildFixtureArtifact,
  type FakeHandler,
  fakeSpawner,
  fakeUi,
  LOGGED_IN,
  makeTestKey,
  type TestKey,
} from "../test-fixtures.ts";
import { install } from "./install.ts";

const NOT_FOUND = { code: 1, stderr: "This Worker does not exist on your account. [code: 10007]" };

let tmpRoot: string;
let key: TestKey;
let artifactDir: string;
beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "appflare-cli-install-"));
  key = await makeTestKey();
  artifactDir = (await buildFixtureArtifact({ sign: key })).dir;
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(artifactDir, { recursive: true, force: true });
});

function setup(overrides: Record<string, FakeHandler> = {}) {
  const secrets: Record<string, string> = {};
  let deployedConfig: Record<string, unknown> | undefined;
  const fake = fakeSpawner({
    whoami: () => ({ stdout: LOGGED_IN }),
    "deployments list": () => NOT_FOUND,
    "d1 list": () => ({ stdout: "[]" }),
    "kv namespace": () => ({ stdout: "[]" }),
    deploy: (call) => {
      const configPath = call.args[call.args.indexOf("--config") + 1] as string;
      deployedConfig = JSON.parse(readFileSync(configPath, "utf8"));
      writeFileSync(
        call.env.WRANGLER_OUTPUT_FILE_PATH as string,
        `${JSON.stringify({ type: "deploy", worker_name: "appflare", version_id: "v-1", targets: ["https://appflare.acme.workers.dev", "schedule: */30 * * * *"] })}\n`,
      );
      return {};
    },
    "secret put": (call) => {
      if (call.stdin.kind !== "text") throw new Error("secret not on stdin");
      secrets[call.args[2] as string] = call.stdin.text;
      return { stdout: `✨ Success! Uploaded secret ${call.args[2]}` };
    },
    ...overrides,
  });
  const { ui, lines, results } = fakeUi();
  const fetched: string[] = [];
  const ctx: CommandContext = {
    ui,
    env: {},
    fetch: async (url) => {
      fetched.push(url);
      return Response.json({ version: "0.1.0", db: "ok", schemaVersion: 2 });
    },
    spawner: fake.spawner,
    wranglerBin: "/fake/wrangler.js",
    tmpRoot,
    keys: [key.key],
    sleep: async () => {},
  };
  return { ctx, calls: fake.calls, secrets, lines, results, fetched, config: () => deployedConfig };
}

describe("install", () => {
  it("deploys the verified artifact, sets the auth secret, and prints only the manager URL", async () => {
    const t = setup();
    await install({ artifactDir, yes: true, allowUnsigned: false }, t.ctx);

    expect(t.calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "whoami --json",
      "deployments list",
      "d1 list",
      "kv namespace",
      "deploy --config",
      "secret put",
    ]);
    // Every command after the account choice targets it.
    for (const call of t.calls.slice(1)) {
      expect(call.env.CLOUDFLARE_ACCOUNT_ID).toBe("acc-1");
    }
    const config = t.config();
    expect(config).toMatchObject({ name: "appflare", main: "worker/index.js", workers_dev: true });
    expect(JSON.stringify(config)).not.toContain("account_id");

    // No setup secret any more: the setup page asks for a Cloudflare API token.
    expect(Object.keys(t.secrets)).toEqual(["BETTER_AUTH_SECRET"]);
    expect(t.results).toEqual(["https://appflare.acme.workers.dev/"]);
    const log = t.lines.join("\n");
    expect(log).toContain("finish setup");
    // The secret never reaches the progress output.
    expect(log).not.toContain(t.secrets.BETTER_AUTH_SECRET);
    expect(t.fetched).toEqual(["https://appflare.acme.workers.dev/api/health"]);
    // The temp dir is gone.
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("downloads, verifies, and installs the latest release", async () => {
    const t = setup();
    const files: Record<string, Buffer> = Object.fromEntries(
      readdirSync(artifactDir).map((f) => [f, readFileSync(path.join(artifactDir, f))]),
    );
    const assetUrl = (name: string) =>
      `https://api.github.com/repos/appflare/appflare/releases/assets/${name}`;
    t.ctx.fetch = async (url) => {
      if (url.endsWith("?per_page=100")) {
        return Response.json([
          {
            id: 1,
            tag_name: "manager@0.1.0",
            draft: false,
            prerelease: false,
            assets: Object.entries(files).map(([name, data]) => ({
              name,
              url: assetUrl(name),
              size: data.length,
            })),
          },
        ]);
      }
      const name = url.split("/").at(-1) as string;
      if (files[name]) return new Response(new Uint8Array(files[name]));
      return Response.json({ version: "0.1.0", db: "ok" });
    };
    await install({ yes: true, allowUnsigned: false }, t.ctx);
    expect(t.results).toEqual(["https://appflare.acme.workers.dev/"]);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("refuses a release from before token-first setup, before deploying", async () => {
    const older = await buildFixtureArtifact({
      sign: key,
      mutate: (m) => {
        m.worker.bindings = m.worker.bindings.filter((b) => b.type !== "version_metadata");
      },
    });
    const t = setup();
    try {
      await expect(
        install({ artifactDir: older.dir, yes: true, allowUnsigned: false }, t.ctx),
      ).rejects.toThrow("predates setup with a Cloudflare API token");
      expect(t.calls.some((c) => c.args[0] === "deploy" || c.args[0] === "secret")).toBe(false);
      expect(readdirSync(tmpRoot)).toEqual([]);
    } finally {
      rmSync(older.dir, { recursive: true, force: true });
    }
  });

  it("refuses to install over an existing Worker, before deploying", async () => {
    const t = setup({ "deployments list": () => ({ stdout: "[]" }) });
    await expect(install({ artifactDir, yes: true, allowUnsigned: false }, t.ctx)).rejects.toThrow(
      'A Worker named "appflare" already exists',
    );
    expect(t.calls.some((c) => c.args[0] === "deploy")).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("refuses leftover D1 databases and KV namespaces", async () => {
    const d1 = setup({
      "d1 list": () => ({ stdout: JSON.stringify([{ uuid: "u", name: "appflare" }]) }),
    });
    await expect(install({ artifactDir, yes: true, allowUnsigned: false }, d1.ctx)).rejects.toThrow(
      "npx wrangler d1 delete appflare",
    );
    const kv = setup({
      "kv namespace": () => ({ stdout: JSON.stringify([{ id: "k1", title: "appflare-kv" }]) }),
    });
    await expect(install({ artifactDir, yes: true, allowUnsigned: false }, kv.ctx)).rejects.toThrow(
      "--namespace-id k1",
    );
  });

  it("rejects an artifact signed by an untrusted key and removes the temp dir", async () => {
    const t = setup();
    t.ctx.keys = [(await makeTestKey()).key];
    await expect(install({ artifactDir, yes: true, allowUnsigned: false }, t.ctx)).rejects.toThrow(
      "does not verify",
    );
    expect(t.calls.some((c) => c.args[0] === "deploy")).toBe(false);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("allows an unsigned artifact only with APPFLARE_DEV=1 and --artifact-dir", async () => {
    rmSync(path.join(artifactDir, "manifest.sig"));
    const t = setup();
    await expect(install({ artifactDir, yes: true, allowUnsigned: true }, t.ctx)).rejects.toThrow(
      "needs APPFLARE_DEV=1",
    );
    t.ctx.env = { APPFLARE_DEV: "1" };
    await expect(install({ yes: true, allowUnsigned: true }, t.ctx)).rejects.toThrow(
      "only applies to --artifact-dir",
    );
    await install({ artifactDir, yes: true, allowUnsigned: true }, t.ctx);
    expect(t.lines.join("\n")).toContain("--allow-unsigned");
    expect(t.results).toHaveLength(1);
  });

  it("warns how to start over when a secret cannot be set", async () => {
    const t = setup({ "secret put": () => ({ code: 1, stderr: "boom" }) });
    await expect(install({ artifactDir, yes: true, allowUnsigned: false }, t.ctx)).rejects.toThrow(
      "boom",
    );
    expect(t.lines).toEqual(
      expect.arrayContaining([
        "!   npx wrangler delete --name appflare",
        "!   npx wrangler workflows delete appflare-jobs",
        "!   npx wrangler d1 delete appflare",
        "!   npx wrangler kv namespace delete appflare-kv",
      ]),
    );
    expect(t.results).toEqual([]);
  });

  it("warns how to start over when wrangler reports no workers.dev URL", async () => {
    const t = setup({ deploy: () => ({}) });
    await expect(install({ artifactDir, yes: true, allowUnsigned: false }, t.ctx)).rejects.toThrow(
      "did not report a deploy",
    );
    expect(t.lines.join("\n")).toContain("npx wrangler delete --name appflare");
    expect(t.calls.some((c) => c.args[0] === "secret")).toBe(false);
  });

  it("deploys with stdin closed under --yes, even in a terminal", async () => {
    const yes = setup();
    yes.ctx.ui = fakeUi({ interactive: true }).ui;
    await install({ artifactDir, yes: true, allowUnsigned: false }, yes.ctx);
    const deployYes = yes.calls.find((c) => c.args[0] === "deploy");
    expect(deployYes?.stdin).toEqual({ kind: "ignore" });
    expect(deployYes?.args).toContain("--strict");

    const interactive = setup();
    interactive.ctx.ui = fakeUi({ interactive: true }).ui;
    await install({ artifactDir, yes: false, allowUnsigned: false }, interactive.ctx);
    expect(interactive.calls.find((c) => c.args[0] === "deploy")?.stdin).toEqual({
      kind: "inherit",
    });
  });

  it("still prints the link when the manager is slow to answer", async () => {
    const t = setup();
    t.ctx.fetch = async () => new Response("error code: 1042", { status: 404 });
    t.ctx.healthTimeoutMs = 0;
    await install({ artifactDir, yes: true, allowUnsigned: false }, t.ctx);
    expect(t.lines.join("\n")).toContain("has not answered yet");
    expect(t.results).toHaveLength(1);
  });

  it("deploys the manager with this run's install id, or with usage data off", async () => {
    const on = setup();
    on.ctx.telemetry = new CliTelemetry({
      env: {},
      optOut: false,
      fetch: on.ctx.fetch,
      ui: on.ctx.ui,
    });
    await install({ artifactDir, yes: true, allowUnsigned: false }, on.ctx);
    expect(on.config()?.vars).toMatchObject({ APPFLARE_INSTALL_ID: on.ctx.telemetry.installId });
    expect(on.ctx.telemetry).toMatchObject({
      step: "health",
      nameIsDefault: true,
      loginNeeded: false,
    });

    const off = setup();
    off.ctx.telemetry = new CliTelemetry({
      env: {},
      optOut: true,
      fetch: off.ctx.fetch,
      ui: off.ctx.ui,
    });
    await install({ artifactDir, yes: true, allowUnsigned: false }, off.ctx);
    expect(off.config()?.vars).toMatchObject({ APPFLARE_TELEMETRY: "off" });
    expect(JSON.stringify(off.config())).not.toContain("APPFLARE_INSTALL_ID");
  });

  it("records the step a failed install reached", async () => {
    const t = setup({ deploy: () => ({ code: 1 }) });
    t.ctx.telemetry = new CliTelemetry({
      env: {},
      optOut: false,
      fetch: t.ctx.fetch,
      ui: t.ctx.ui,
    });
    await expect(install({ artifactDir, yes: true, allowUnsigned: false }, t.ctx)).rejects.toThrow(
      "wrangler deploy",
    );
    expect(t.ctx.telemetry.step).toBe("deploy");
  });

  it("rejects a Node version below 22", async () => {
    const t = setup();
    t.ctx.nodeVersion = "20.1.0";
    await expect(install({ artifactDir, yes: true, allowUnsigned: false }, t.ctx)).rejects.toThrow(
      "Node.js 22",
    );
    expect(t.calls).toEqual([]);
  });
});
