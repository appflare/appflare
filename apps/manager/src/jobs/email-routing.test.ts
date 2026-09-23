import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CatalogEmailRouting } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { DEFAULT_CATCH_ALL, emailRouteCfId } from "../installs/email-routing";
import type { StartInstallInput } from "../installs/install-input";
import { startInstallCore } from "../installs/start-install.server";
import { startUninstallCore } from "../installs/start-uninstall.server";
import { baseCatalog, buildArtifactFixture } from "../test/artifact-fixture";
import { ACC, fakeAccount, TOKEN } from "../test/fake-account";
import { type EmailWorld, fakeEmailRouting, ZONE_ID } from "../test/fake-email-routing";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { type InstallJobParams, runInstall } from "./install";
import type { JobEnv } from "./run-job";
import { runUninstall, type UninstallJobParams } from "./uninstall";

/**
 * Email Routing in the install and uninstall jobs, end to end against the
 * stateful fakes of the account (fake-account.ts) and of one zone's Email
 * Routing (fake-email-routing.ts), with the local D1. The Workflow engine is
 * replaced by `fakeStep`.
 */

const NOW = 1_790_000_000_000;
const jobEnv = (): JobEnv => ({ DB: env.DB, CF_API_TOKEN: TOKEN });
const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });

/** The account (Worker upload, assets, subdomain) plus one zone's Email Routing. */
async function world(
  emailOver: Partial<EmailWorld> = {},
  /** Runs when the Worker is uploaded: between the zone check and the Email Routing steps. */
  onUpload?: (email: EmailWorld) => void,
) {
  const account = fakeAccount(null);
  const email = fakeEmailRouting(ACC, emailOver);
  const scripts = new Set<string>();
  const order: string[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const handled = await email.handle(request);
    if (handled !== null) {
      order.push(`email ${request.method} ${new URL(input).pathname}`);
      return handled;
    }
    const path = new URL(input).pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    if (key === "GET /tokens/verify") return ok({ id: "t", status: "active" });
    if (key === "GET /workers/scripts") return ok([...scripts].map((id) => ({ id })));
    const secret = /^PUT \/workers\/scripts\/([^/]+)\/secrets$/.exec(key);
    if (secret) return ok({ name: "x", type: "secret_text" });
    const del = /^DELETE \/workers\/scripts\/([^/]+)$/.exec(key);
    if (del?.[1] !== undefined) {
      order.push(`delete Worker ${del[1]}`);
      return scripts.delete(del[1])
        ? ok(null)
        : Response.json(
            { success: false, errors: [{ code: 10007, message: "gone" }] },
            { status: 404 },
          );
    }
    if (/^PUT \/workers\/scripts\/[^/]+$/.test(key)) {
      scripts.add(path.split("/").at(-1) ?? "");
      onUpload?.(email.world);
    }
    return account.fetch(input, init);
  };
  return { account, email, scripts, order, fetch };
}

async function install(
  config: CatalogEmailRouting | undefined,
  emailOver: Partial<EmailWorld> = {},
  input: Partial<StartInstallInput> = { emailRouting: { zoneId: ZONE_ID } },
  bindings: Array<{ type: string; name: string }> = [],
  onUpload?: (email: EmailWorld) => void,
) {
  const catalog = baseCatalog({
    install: {
      ...baseCatalog().install,
      ...(config === undefined ? {} : { emailRouting: config }),
    },
  });
  const fixture = await buildArtifactFixture({ catalog, bindings });
  const w = await world(emailOver, onUpload);
  let params: InstallJobParams | null = null;
  let n = 0;
  const { jobId, installId } = await startInstallCore(
    {
      db: env.DB,
      loadApp: async () => ({ app: fixture.index, manifest: fixture.manifest }),
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => `id${++n}`,
    },
    {
      slug: "cut",
      workerName: "cut",
      secrets: { ADMIN_PASSWORD: "pw" },
      vars: {},
      paidConfirmed: false,
      requirementsConfirmed: false,
      ...input,
    },
  );
  if (params === null) throw new Error("no Workflow params");
  const step = fakeStep();
  const fetch = async (i: string, init?: RequestInit): Promise<Response> =>
    fixture.serve(i, init) ?? w.fetch(i, init);
  const self = fakeSelf(jobEnv(), { fetch, now: () => NOW });
  let error: unknown = null;
  try {
    await runInstall({
      params,
      step,
      env: { ...jobEnv(), SELF: self },
      deps: { fetch, signingKeys: fixture.keys, now: () => NOW },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT status, error, input_json FROM jobs WHERE id = ?1")
    .bind(jobId)
    .first<{ status: string; error: string | null; input_json: string }>();
  const routes = (
    await env.DB.prepare(
      "SELECT id, name, cf_id, deleted_at FROM resources WHERE install_id = ?1 AND kind = 'email_route' ORDER BY rowid",
    )
      .bind(installId)
      .all<{ id: string; name: string; cf_id: string; deleted_at: number | null }>()
  ).results;
  const kinds = (
    await env.DB.prepare("SELECT kind FROM resources WHERE install_id = ?1 AND deleted_at IS NULL")
      .bind(installId)
      .all<{ kind: string }>()
  ).results.map((r) => r.kind);
  const logs = (
    await env.DB.prepare("SELECT level, message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<{ level: string; message: string }>()
  ).results;
  return { ...w, installId, step, self, error, job, routes, kinds, logs };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
});

describe("install with Email Routing", () => {
  it("turns routing on, routes the addresses and the catch-all to the Worker, and records each", async () => {
    const r = await install({ rules: ["inbox"], catchAll: true });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const { world } = r.email;
    expect(world.routingEnabled).toBe(true);
    expect(world.rules).toHaveLength(1);
    expect(world.rules[0]).toMatchObject({
      name: "cut (installed by Appflare)",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "inbox@example.com" }],
      actions: [{ type: "worker", value: ["cut"] }],
    });
    expect(world.catchAll).toEqual({
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: ["cut"] }],
    });
    const ruleId = world.rules[0]?.id;
    expect(r.routes.map(({ name, cf_id, deleted_at }) => ({ name, cf_id, deleted_at }))).toEqual([
      { name: "example.com", cf_id: `routing:${ZONE_ID}`, deleted_at: null },
      { name: "inbox@example.com", cf_id: `rule:${ZONE_ID}:${ruleId}`, deleted_at: null },
      {
        name: "*@example.com",
        cf_id: emailRouteCfId({ kind: "catch_all", zoneId: ZONE_ID, previous: DEFAULT_CATCH_ALL }),
        deleted_at: null,
      },
    ]);
    // The zone is read through the unit, before anything is created.
    expect(r.self.calls.map((c) => c.unit)).toContain("inspectEmailRouting");
    const names = r.step.names;
    expect(names.indexOf("check Email Routing")).toBeLessThan(names.indexOf("record Worker name"));
    expect(names.indexOf("upload Worker script")).toBeLessThan(
      names.indexOf("make sure Email Routing is on for example.com"),
    );
    expect(names).toContain("route inbox@example.com to the Worker");
    expect(names).toContain("send other mail at example.com to the Worker");
    // The zone travels in the job input; nothing secret about it.
    expect(JSON.parse(r.job?.input_json ?? "{}").emailRouting).toEqual({ zoneId: ZONE_ID });
    expect(r.logs.map((l) => l.message).join("\n")).toContain(
      "The install will turn Email Routing on for example.com",
    );
  });

  it("leaves routing alone when it is already on", async () => {
    const r = await install({ rules: ["inbox"] }, { routingEnabled: true });
    expect(r.job?.status).toBe("succeeded");
    expect(r.routes.map((x) => x.name)).toEqual(["inbox@example.com"]);
    expect(r.email.world.calls).not.toContain(`POST /zones/${ZONE_ID}/email/routing/dns`);
  });

  it("records nothing when routing was turned on by something else after the check", async () => {
    const r = await install({ rules: ["inbox"] }, {}, undefined, [], (w) => {
      w.routingEnabled = true;
    });
    expect(r.job?.status).toBe("succeeded");
    expect(r.routes.map((x) => x.name)).toEqual(["inbox@example.com"]);
    expect(r.email.world.calls).not.toContain(`POST /zones/${ZONE_ID}/email/routing/dns`);
    expect(r.logs.map((l) => l.message).join("\n")).toContain(
      "was turned on by something else since the check",
    );
  });

  it("turns routing on again, and records it, when it was turned off after the check", async () => {
    const r = await install({ rules: ["inbox"] }, { routingEnabled: true }, undefined, [], (w) => {
      w.routingEnabled = false;
    });
    expect(r.job?.status).toBe("succeeded");
    expect(r.email.world.routingEnabled).toBe(true);
    expect(r.routes.map((x) => x.name)).toEqual(["example.com", "inbox@example.com"]);
    expect(r.logs.map((l) => l.message).join("\n")).toContain("was turned off since the check");
  });

  it("stops before creating anything when the catch-all already delivers elsewhere", async () => {
    const r = await install(
      { catchAll: true },
      {
        catchAll: {
          enabled: true,
          matchers: [{ type: "all" }],
          actions: [{ type: "forward", value: ["me@example.net"] }],
        },
      },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain(
      "check Email Routing: The catch-all of example.com already sends mail to forwarding to me@example.net",
    );
    expect(r.kinds).toEqual([]);
    expect(r.scripts.size).toBe(0);
    expect(r.email.world.routingEnabled).toBe(false);
  });

  it("names the permissions the token lacks and creates nothing", async () => {
    const r = await install(
      { rules: ["inbox"] },
      { forbidden: [`/zones/${ZONE_ID}/email/routing/rules`] },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain("the Cloudflare token lacks Email Routing Rules: Edit");
    expect(r.kinds).toEqual([]);
  });

  it("creates a rule once when a retry follows a lost answer", async () => {
    const r = await install(
      { rules: ["inbox"] },
      { routingEnabled: true, failAfter: new Set([`POST /zones/${ZONE_ID}/email/routing/rules`]) },
    );
    expect(r.job?.status).toBe("succeeded");
    expect(r.email.world.rules).toHaveLength(1);
    expect(r.step.retried["route inbox@example.com to the Worker"]).toBe(2);
    expect(r.routes).toHaveLength(1);
  });

  it("forgets the routing record when Cloudflare refuses to turn routing on", async () => {
    const r = await install(
      { catchAll: true },
      { forbidden: [`/zones/${ZONE_ID}/email/routing/dns`] },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain("The token needs Zone Settings: Edit on the zone");
    expect(r.routes.map((x) => [x.name, x.deleted_at !== null])).toEqual([["example.com", true]]);
    // The Worker was uploaded and stays recorded for the uninstall.
    expect(r.kinds).toContain("worker");
  });

  it("refuses to start without a zone, or with one for an app that takes none", async () => {
    await expect(install({ catchAll: true }, {}, {})).rejects.toThrow(
      "Cut receives email. Choose the zone",
    );
    await expect(install(undefined)).rejects.toThrow(
      "Cut does not receive email; it takes no zone.",
    );
  });
});

describe("uninstall with Email Routing", () => {
  async function uninstallAfterInstall(
    config: CatalogEmailRouting,
    emailOver: Partial<EmailWorld> = {},
    between?: (w: EmailWorld) => void,
  ) {
    const installed = await install(config, emailOver);
    expect(installed.job?.status).toBe("succeeded");
    between?.(installed.email.world);
    installed.order.length = 0;
    let params: UninstallJobParams | null = null;
    const { jobId } = await startUninstallCore(
      {
        db: env.DB,
        createJob: async (id, p) => {
          params = p;
          return { id };
        },
        now: () => new Date(NOW),
        newId: () => `u-${Math.random().toString(36).slice(2, 8)}`,
      },
      { installId: installed.installId, deleteResources: [] },
    );
    if (params === null) throw new Error("no Workflow params");
    const step = fakeStep();
    await runUninstall({
      params,
      step,
      env: jobEnv(),
      deps: { fetch: installed.fetch, now: () => NOW },
    });
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?1")
      .bind(jobId)
      .first<{ status: string }>();
    const live = (
      await env.DB.prepare(
        "SELECT kind FROM resources WHERE install_id = ?1 AND kind = 'email_route' AND deleted_at IS NULL",
      )
        .bind(installed.installId)
        .all()
    ).results;
    const logs = (
      await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = ?1 ORDER BY id")
        .bind(jobId)
        .all<{ message: string }>()
    ).results.map((l) => l.message);
    return { ...installed, step, job, live, logs };
  }

  it("removes the rule and catch-all before the Worker, then turns routing off", async () => {
    const r = await uninstallAfterInstall({ rules: ["inbox"], catchAll: true });
    expect(r.job?.status).toBe("succeeded");
    const { world } = r.email;
    expect(world.rules).toEqual([]);
    expect(world.catchAll).toEqual({
      enabled: false,
      matchers: [{ type: "all" }],
      actions: [{ type: "drop" }],
    });
    expect(world.routingEnabled).toBe(false);
    expect(r.live).toEqual([]);
    const deleteWorker = r.order.indexOf("delete Worker cut");
    const lastEmail = r.order.findLastIndex((o) => o.startsWith("email "));
    expect(deleteWorker).toBeGreaterThan(lastEmail);
    expect(r.order[lastEmail]).toBe(`email DELETE /client/v4/zones/${ZONE_ID}/email/routing/dns`);
    expect(r.step.names.slice(1, 4)).toEqual([
      "remove email route inbox@example.com",
      "restore catch-all *@example.com",
      "release Email Routing for example.com",
    ]);
  });

  it("leaves routing on when another rule uses it, and a changed catch-all alone", async () => {
    const r = await uninstallAfterInstall({ catchAll: true }, {}, (w) => {
      w.rules.push({
        id: "someone-else",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "hi@example.com" }],
        actions: [{ type: "forward", value: ["me@example.net"] }],
      });
      w.catchAll = {
        enabled: true,
        matchers: [{ type: "all" }],
        actions: [{ type: "forward", value: ["me@example.net"] }],
      };
    });
    expect(r.job?.status).toBe("succeeded");
    expect(r.email.world.routingEnabled).toBe(true);
    expect(r.email.world.catchAll.actions).toEqual([
      { type: "forward", value: ["me@example.net"] },
    ]);
    expect(r.logs.join("\n")).toContain('no longer delivers to "cut", so it was left alone');
    expect(r.logs.join("\n")).toContain(
      "Left Email Routing on for example.com: 1 other routing rule(s) and an active catch-all still use it.",
    );
    expect(r.live).toEqual([]);
  });

  it("puts back the catch-all the install found", async () => {
    const found = {
      enabled: false,
      matchers: [{ type: "all" }],
      actions: [{ type: "forward", value: ["me@example.net"] }],
    };
    const r = await uninstallAfterInstall({ catchAll: true }, { catchAll: found });
    expect(r.job?.status).toBe("succeeded");
    expect(r.email.world.catchAll).toEqual(found);
    expect(r.logs.join("\n")).toContain(
      "back as it was before the install: forwarding to me@example.net, off.",
    );
  });

  it("never turns off routing Appflare did not turn on", async () => {
    const r = await uninstallAfterInstall({ rules: ["inbox"] }, { routingEnabled: true });
    expect(r.job?.status).toBe("succeeded");
    expect(r.email.world.rules).toEqual([]);
    expect(r.email.world.routingEnabled).toBe(true);
    expect(r.email.world.calls).not.toContain(`DELETE /zones/${ZONE_ID}/email/routing/dns`);
  });

  it("counts a rule deleted by hand as removed", async () => {
    const r = await uninstallAfterInstall({ rules: ["inbox"] }, { routingEnabled: true }, (w) => {
      w.rules = [];
    });
    expect(r.job?.status).toBe("succeeded");
    expect(r.logs.join("\n")).toContain("The routing rule for inbox@example.com was already gone.");
  });
});
