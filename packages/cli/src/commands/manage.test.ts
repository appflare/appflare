import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../context.ts";
import { type FakeHandler, fakeSpawner, fakeUi, LOGGED_IN } from "../test-fixtures.ts";
import { rollback } from "./rollback.ts";
import { status } from "./status.ts";
import { leftoverResources, uninstall } from "./uninstall.ts";

const deployments = [
  {
    id: "d1",
    created_on: "2026-09-20T00:00:00Z",
    source: "wrangler",
    versions: [{ version_id: "v-1", percentage: 100 }],
  },
  {
    id: "d2",
    created_on: "2026-09-21T00:00:00Z",
    source: "wrangler",
    versions: [{ version_id: "v-2", percentage: 100 }],
  },
  {
    id: "d3",
    created_on: "2026-09-22T00:00:00Z",
    source: "secret",
    versions: [{ version_id: "v-3", percentage: 100 }],
  },
];
const version = (id: string, appflare: string) => ({
  id,
  metadata: { created_on: "2026-09-22T00:00:00Z", source: "wrangler" },
  resources: {
    bindings: [
      { type: "plain_text", name: "APPFLARE_VERSION", text: appflare },
      { type: "d1", name: "DB", id: "db-uuid" },
      { type: "kv_namespace", name: "KV", namespace_id: "kv-id" },
      { type: "workflow", name: "JOBS", workflow_name: "appflare-jobs", class_name: "JobWorkflow" },
      { type: "secret_text", name: "SETUP_TOKEN" },
    ],
  },
});

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "appflare-cli-manage-"));
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function setup(overrides: Record<string, FakeHandler> = {}, ui = fakeUi()) {
  const fake = fakeSpawner({
    whoami: () => ({ stdout: LOGGED_IN }),
    "deployments list": () => ({ stdout: JSON.stringify(deployments) }),
    "versions list": () => ({
      stdout: JSON.stringify(
        deployments.map((d) => version(d.versions[0]?.version_id as string, "x")),
      ),
    }),
    "versions view": (call) => ({
      stdout: JSON.stringify(
        version(call.args[2] as string, call.args[2] === "v-3" ? "0.2.0" : "0.1.0"),
      ),
    }),
    "d1 list": () => ({ stdout: JSON.stringify([{ uuid: "db-uuid", name: "appflare" }]) }),
    "kv namespace": () => ({ stdout: JSON.stringify([{ id: "kv-id", title: "appflare-kv" }]) }),
    auth: () => ({ stdout: JSON.stringify({ type: "oauth", token: "oauth-secret" }) }),
    rollback: () => ({}),
    delete: () => ({}),
    ...overrides,
  });
  const fetched: { url: string; auth: string | null }[] = [];
  const ctx: CommandContext = {
    ui: ui.ui,
    env: {},
    fetch: async (url, init) => {
      fetched.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/workers/subdomain")) {
        return Response.json({ success: true, result: { subdomain: "acme" } });
      }
      return Response.json({ version: "0.2.0", db: "ok" });
    },
    spawner: fake.spawner,
    wranglerBin: "/fake/wrangler.js",
    tmpRoot,
  };
  return { ctx, calls: fake.calls, fetched, ...ui };
}

describe("status", () => {
  it("reports the active deployment, the Appflare version, and health", async () => {
    const t = setup();
    await status({}, t.ctx);
    const report = t.results.join("\n");
    expect(report).toContain("URL:       https://appflare.acme.workers.dev");
    expect(report).toContain("Appflare:  0.2.0");
    expect(report).toContain("Health:    ok (version 0.2.0, db ok)");
    expect(report).toContain("Version:   v-3 (100%)");
    expect(report).toContain("* v-3");
    expect(report).not.toContain("oauth-secret");
    expect(t.lines.join("\n")).not.toContain("oauth-secret");
    expect(t.fetched).toEqual([
      {
        url: "https://api.cloudflare.com/client/v4/accounts/acc-1/workers/subdomain",
        auth: "Bearer oauth-secret",
      },
      { url: "https://appflare.acme.workers.dev/api/health", auth: null },
    ]);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("uses --url without looking anything up", async () => {
    const t = setup();
    await status({ url: "https://mgr.example.workers.dev" }, t.ctx);
    expect(t.calls.some((c) => c.args[0] === "auth")).toBe(false);
    expect(t.fetched.map((f) => f.url)).toEqual(["https://mgr.example.workers.dev/api/health"]);
  });

  it("says when the Worker does not exist", async () => {
    const t = setup({ "deployments list": () => ({ code: 1, stderr: "[code: 10007]" }) });
    await expect(status({ name: "nope" }, t.ctx)).rejects.toThrow('no Worker named "nope"');
  });
});

describe("rollback", () => {
  it("rolls back to the previous deployment after confirming", async () => {
    const t = setup({}, fakeUi({ interactive: true, answers: [true] }));
    await rollback({ yes: false }, t.ctx);
    const call = t.calls.find((c) => c.args[0] === "rollback");
    expect(call?.args.slice(0, 4)).toEqual(["rollback", "v-2", "--name", "appflare"]);
    expect(call?.stdin).toEqual({ kind: "ignore" });
    expect(t.results).toEqual(['Rolled back "appflare" to version v-2.']);
  });

  it("does nothing when the user declines", async () => {
    const t = setup({}, fakeUi({ interactive: true, answers: [false] }));
    await rollback({ yes: false }, t.ctx);
    expect(t.calls.some((c) => c.args[0] === "rollback")).toBe(false);
  });

  it("needs --yes without a terminal, and takes --to", async () => {
    const t = setup();
    await expect(rollback({ yes: false }, t.ctx)).rejects.toThrow("Pass --yes");
    await rollback({ yes: true, to: "v-1" }, t.ctx);
    expect(t.calls.find((c) => c.args[0] === "rollback")?.args[1]).toBe("v-1");
  });

  it("refuses to roll back to the active version", async () => {
    const t = setup();
    await expect(rollback({ yes: true, to: "v-3" }, t.ctx)).rejects.toThrow(
      "already the active version",
    );
  });
});

describe("uninstall", () => {
  it("requires --yes", async () => {
    const t = setup();
    await expect(uninstall({ yes: false }, t.ctx)).rejects.toThrow("--yes");
    expect(t.calls).toEqual([]);
  });

  it("deletes the Worker and lists the resources it leaves", async () => {
    const t = setup();
    await uninstall({ yes: true }, t.ctx);
    expect(t.calls.find((c) => c.args[0] === "delete")?.args.slice(0, 4)).toEqual([
      "delete",
      "--name",
      "appflare",
      "--force",
    ]);
    const report = t.results.join("\n");
    expect(report).toContain('D1 database "appflare" (db-uuid)');
    expect(report).toContain('KV namespace "appflare-kv" (kv-id)');
    expect(report).toContain("npx wrangler d1 delete appflare");
    expect(report).toContain("npx wrangler kv namespace delete --namespace-id kv-id");
    expect(report).not.toContain("workflow");
    expect(report).toContain("were not touched");
  });
});

describe("uninstall account choice", () => {
  const both = JSON.stringify({
    loggedIn: true,
    accounts: [
      { id: "acc-1", name: "Acme" },
      { id: "acc-2", name: "Other" },
    ],
  });
  it("asks which account when several are visible, even with --yes", async () => {
    const t = setup(
      { whoami: () => ({ stdout: both }) },
      fakeUi({ interactive: true, answers: ["acc-2"] }),
    );
    await uninstall({ yes: true }, t.ctx);
    expect(t.calls.find((c) => c.args[0] === "delete")?.env.CLOUDFLARE_ACCOUNT_ID).toBe("acc-2");
  });
  it("needs CLOUDFLARE_ACCOUNT_ID without a terminal", async () => {
    const t = setup({ whoami: () => ({ stdout: both }) });
    await expect(uninstall({ yes: true }, t.ctx)).rejects.toThrow("CLOUDFLARE_ACCOUNT_ID");
  });
});

describe("leftoverResources", () => {
  it("falls back to ids when names are unknown and skips other bindings", () => {
    const leftovers = leftoverResources(version("v", "1").resources.bindings, new Map(), new Map());
    expect(leftovers.map((l) => l.deleteCommand)).toEqual([
      "npx wrangler d1 delete db-uuid",
      "npx wrangler kv namespace delete --namespace-id kv-id",
    ]);
  });
});
