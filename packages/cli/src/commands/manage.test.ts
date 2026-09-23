import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../context.ts";
import { type FakeHandler, fakeSpawner, fakeUi, LOGGED_IN } from "../test-fixtures.ts";
import { rollback } from "./rollback.ts";
import { status } from "./status.ts";
import { boundResources, deleteCommandFor, hasManagerBindings, uninstall } from "./uninstall.ts";

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
  // What /api/health answers; a rollback switches it to the rolled-back version.
  const health: Record<string, unknown> = {
    version: "0.2.0",
    db: "ok",
    latestVersion: "0.3.0",
    updateAvailable: true,
  };
  const kvDelete: FakeHandler = overrides["kv delete"] ?? (() => ({}));
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
    "kv namespace": (call) =>
      call.args[2] === "delete"
        ? kvDelete(call)
        : { stdout: JSON.stringify([{ id: "kv-id", title: "appflare-kv" }]) },
    "d1 delete": () => ({}),
    auth: () => ({ stdout: JSON.stringify({ type: "oauth", token: "oauth-secret" }) }),
    rollback: () => {
      health.version = "0.1.0";
      return {};
    },
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
      return Response.json(health);
    },
    spawner: fake.spawner,
    wranglerBin: "/fake/wrangler.js",
    tmpRoot,
    sleep: async () => {},
  };
  return { ctx, calls: fake.calls, fetched, health, ...ui };
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

  it("says when an update is available, and when the manager is up to date", async () => {
    const t = setup();
    await status({}, t.ctx);
    expect(t.results.join("\n")).toContain("Updates:   Update available: 0.3.0 (running 0.2.0)");

    const current = setup();
    Object.assign(current.health, { latestVersion: "0.2.0", updateAvailable: false });
    await status({}, current.ctx);
    expect(current.results.join("\n")).toContain(
      "Updates:   Up to date (running 0.2.0, latest 0.2.0)",
    );
  });

  it("says unknown when the manager reports a latest version but not whether it is newer", async () => {
    const t = setup();
    delete t.health.updateAvailable;
    await status({}, t.ctx);
    expect(t.results.join("\n")).toMatch(/Updates: {3}unknown \(manager 0\.2\.0 reports 0\.3\.0/);
  });

  it("handles managers that have not checked, or do not report, releases", async () => {
    const unchecked = setup();
    Object.assign(unchecked.health, { latestVersion: null, updateAvailable: false });
    await status({}, unchecked.ctx);
    expect(unchecked.results.join("\n")).toContain("has not checked for releases yet");

    const older = setup();
    delete older.health.latestVersion;
    delete older.health.updateAvailable;
    await status({}, older.ctx);
    expect(older.results.join("\n")).toContain("does not report updates");
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
    expect(t.results).toEqual([
      'Rolled back "appflare" to version v-2.\nHealth: ok (version 0.1.0, db ok)',
    ]);
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

describe("rollback --list and health", () => {
  it("lists versions with ids and dates and changes nothing", async () => {
    const t = setup();
    await rollback({ yes: false, list: true }, t.ctx);
    const report = t.results.join("\n");
    expect(report).toContain("* v-3  2026-09-22T00:00:00Z");
    expect(report).toMatch(/v-2 {2}2026-09-22T00:00:00Z.*<- default rollback target/);
    expect(report).toContain("rollback --name appflare --to <version-id>");
    expect(t.calls.some((c) => c.args[0] === "rollback")).toBe(false);
  });

  it("reports when the manager still serves the old version", async () => {
    const t = setup({ rollback: () => ({}) });
    t.ctx.healthTimeoutMs = 0;
    await rollback({ yes: true }, t.ctx);
    expect(t.results[0]).toContain(
      "Health: ok (version 0.2.0, db ok); expected 0.1.0, the edge may still be serving the old version",
    );
  });

  it("reports a failing manager after the rollback", async () => {
    const t = setup();
    t.ctx.fetch = async (url) =>
      url.endsWith("/workers/subdomain")
        ? Response.json({ success: true, result: { subdomain: "acme" } })
        : new Response("boom", { status: 500 });
    t.ctx.healthTimeoutMs = 0;
    await rollback({ yes: true }, t.ctx);
    expect(t.results[0]).toContain("Health: FAILING: HTTP 500 (boom)");
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

describe("uninstall --purge", () => {
  const purgeCalls = (calls: { args: string[] }[]) =>
    calls
      .filter((c) => c.args.includes("delete"))
      .map((c) => c.args.filter((a) => a !== "--config" && !a.endsWith("wrangler.json")).join(" "));

  it("deletes the Worker, then its bound D1 and KV, after the name is typed", async () => {
    const t = setup({}, fakeUi({ interactive: true, answers: ["appflare"] }));
    await uninstall({ yes: true, purge: true }, t.ctx);
    expect(purgeCalls(t.calls)).toEqual([
      "delete --name appflare --force",
      "d1 delete appflare -y",
      "kv namespace delete --namespace-id kv-id -y",
    ]);
    const report = t.results.join("\n");
    expect(report).toContain('Deleted the D1 database "appflare" (db-uuid), binding DB.');
    expect(report).toContain('Deleted the KV namespace "appflare-kv" (kv-id), binding KV.');
    expect(report).toContain("were not touched");
    expect(report).not.toContain("NOT deleted");
  });

  it("deletes nothing when the typed name does not match", async () => {
    const t = setup({}, fakeUi({ interactive: true, answers: ["appflar"] }));
    await expect(uninstall({ yes: true, purge: true }, t.ctx)).rejects.toThrow(
      "did not match; nothing was deleted",
    );
    expect(purgeCalls(t.calls)).toEqual([]);
  });

  it("needs a terminal or all three flags", async () => {
    const t = setup();
    await expect(uninstall({ yes: true, purge: true }, t.ctx)).rejects.toThrow(
      "--yes --purge --i-understand-data-loss",
    );
    expect(purgeCalls(t.calls)).toEqual([]);
    await uninstall({ yes: true, purge: true, iUnderstandDataLoss: true }, t.ctx);
    expect(purgeCalls(t.calls)).toHaveLength(3);
    await expect(uninstall({ yes: true, iUnderstandDataLoss: true }, t.ctx)).rejects.toThrow(
      "only applies to --purge",
    );
  });

  it("purges only the resources the manager is bound to, by id, not by name", async () => {
    const t = setup({
      "d1 list": () => ({
        stdout: JSON.stringify([
          { uuid: "u-other", name: "appflare" },
          { uuid: "db-uuid", name: "appflare-db-2" },
        ]),
      }),
      "kv namespace": (call) =>
        call.args[2] === "delete"
          ? {}
          : {
              stdout: JSON.stringify([
                { id: "kv-other", title: "appflare-kv" },
                { id: "kv-id", title: "custom" },
              ]),
            },
    });
    await uninstall({ yes: true, purge: true, iUnderstandDataLoss: true }, t.ctx);
    expect(purgeCalls(t.calls)).toEqual([
      "delete --name appflare --force",
      "d1 delete appflare-db-2 -y",
      "kv namespace delete --namespace-id kv-id -y",
    ]);
    const report = t.results.join("\n");
    expect(report).not.toContain("u-other");
    expect(report).not.toContain("kv-other");
  });

  it("refuses a Worker that is not a manager, even with a <name>-kv namespace", async () => {
    const appVersion = {
      id: "v-3",
      metadata: { created_on: "2026-09-22T00:00:00Z" },
      resources: {
        bindings: [
          { type: "kv_namespace", name: "KV", namespace_id: "kv-id" },
          { type: "d1", name: "DB", id: "db-uuid" },
        ],
      },
    };
    const t = setup({ "versions view": () => ({ stdout: JSON.stringify(appVersion) }) });
    // Answers health like an app, not like a manager (no schemaVersion).
    Object.assign(t.health, { version: "1.0.0", db: "ok" });
    await expect(
      uninstall({ yes: true, purge: true, iUnderstandDataLoss: true }, t.ctx),
    ).rejects.toThrow('The Worker "appflare" is not an Appflare manager');
    expect(purgeCalls(t.calls)).toEqual([]);
    await expect(uninstall({ yes: true }, t.ctx)).rejects.toThrow("not an Appflare manager");
    expect(purgeCalls(t.calls)).toEqual([]);
  });

  it("recognizes a manager by its health answer when the bindings differ", async () => {
    const t = setup({
      "versions view": () => ({
        stdout: JSON.stringify({
          id: "v-3",
          metadata: { created_on: "2026-09-22T00:00:00Z" },
          resources: { bindings: [{ type: "d1", name: "DB", id: "db-uuid" }] },
        }),
      }),
    });
    t.health.schemaVersion = 4;
    await uninstall({ yes: true, purge: true, iUnderstandDataLoss: true }, t.ctx);
    expect(purgeCalls(t.calls)).toEqual([
      "delete --name appflare --force",
      "d1 delete appflare -y",
    ]);
  });

  it("matches by exact name only when the Worker is already gone, and says so", async () => {
    const t = setup(
      { "deployments list": () => ({ code: 1, stderr: "[code: 10007]" }) },
      fakeUi({ interactive: true, answers: ["appflare"] }),
    );
    await uninstall({ yes: true, purge: true }, t.ctx);
    expect(t.lines.join("\n")).toContain("Matching by name");
    expect(purgeCalls(t.calls)).toEqual([
      "d1 delete appflare -y",
      "kv namespace delete --namespace-id kv-id -y",
    ]);
    expect(t.results.join("\n")).toContain('There is no Worker named "appflare"');
  });

  it("reports a failed deletion and still tries the other", async () => {
    const t = setup({ "d1 delete": () => ({ code: 1 }) });
    await expect(
      uninstall({ yes: true, purge: true, iUnderstandDataLoss: true }, t.ctx),
    ).rejects.toThrow("could not be deleted");
    const report = t.results.join("\n");
    expect(report).toContain('FAILED to delete the D1 database "appflare"');
    expect(report).toContain('Deleted the KV namespace "appflare-kv"');
    expect(report).toContain("npx wrangler d1 delete appflare");
  });

  it("stops before any purge when the Worker cannot be deleted", async () => {
    const t = setup({ delete: () => ({ code: 1 }) });
    await expect(
      uninstall({ yes: true, purge: true, iUnderstandDataLoss: true }, t.ctx),
    ).rejects.toThrow("Nothing else was deleted");
    expect(purgeCalls(t.calls)).toEqual(["delete --name appflare --force"]);
  });
});

describe("boundResources", () => {
  it("falls back to ids when names are unknown and skips other bindings", () => {
    const resources = boundResources(version("v", "1").resources.bindings, [], []);
    expect(resources.map(deleteCommandFor)).toEqual([
      "npx wrangler d1 delete db-uuid",
      "npx wrangler kv namespace delete --namespace-id kv-id",
    ]);
  });
  it("recognizes the manager's bindings", () => {
    expect(hasManagerBindings(version("v", "1").resources.bindings)).toBe(true);
    expect(
      hasManagerBindings(version("v", "1").resources.bindings.filter((b) => b.type !== "workflow")),
    ).toBe(false);
  });
});
