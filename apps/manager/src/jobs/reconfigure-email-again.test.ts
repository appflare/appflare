import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import type { CatalogEmailRouting } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  type EmailRouteTarget,
  emailRouteCfId,
  emailRouteKey,
  emailRouteName,
} from "../installs/email-routing";
import { readInstallSettingsCore, startEmailAgainCore } from "../installs/reconfigure.server";
import {
  type ArtifactFixture,
  baseCatalog,
  buildArtifactFixture,
  ZIP_URL,
} from "../test/artifact-fixture";
import { ACC, fakeAccount, TOKEN } from "../test/fake-account";
import { type EmailWorld, fakeEmailRouting, ZONE_ID } from "../test/fake-email-routing";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { INSTALL_ID, OLD_VERSION, type SeedResource, seedInstall } from "../test/seed-install";
import { type ReconfigureJobParams, runReconfigure } from "./reconfigure";
import type { JobEnv } from "./run-job";

/**
 * Setting an email app's Email Routing up again from its settings: the
 * settings change job with `emailAgain`, started the way the app page
 * starts it, against the stateful fakes of the account and of one zone's
 * Email Routing, with the local D1. The install's records are seeded as an
 * update that had to leave parts out leaves them.
 */

const RESOURCES: SeedResource[] = [
  { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
  { kind: "worker", name: "cut", cfId: "cut" },
  { kind: "subdomain", name: "cut.appflare-dev.workers.dev" },
];

const WORKER_ACTION = [{ type: "worker", value: ["cut"] }];
const FORWARD = [{ type: "forward", value: ["me@example.net"] }];

/** A rule the admin made by hand for an address the app does not ask for. */
const SALES_RULE = {
  id: "sales-rule",
  enabled: true,
  matchers: [{ type: "literal", field: "to", value: "sales@example.com" }],
  actions: FORWARD,
};

function ourRule(id: string, address: string) {
  return {
    id,
    name: "cut (installed by Appflare)",
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: address }],
    actions: WORKER_ACTION,
  };
}

/** An `email_route` record as the install job leaves it. */
async function seedRoute(target: EmailRouteTarget, address?: string): Promise<void> {
  const name = emailRouteName(target.kind, {
    zoneName: "example.com",
    ...(address === undefined ? {} : { address }),
  });
  await env.DB.prepare(
    `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
     VALUES (?1, ?2, 'email_route', NULL, ?3, ?4, 1)`,
  )
    .bind(
      `${INSTALL_ID}:email_route:${emailRouteKey(target.kind, name)}`,
      INSTALL_ID,
      name,
      emailRouteCfId(target),
    )
    .run();
}

async function routes() {
  return (
    await env.DB.prepare(
      "SELECT name, cf_id, deleted_at FROM resources WHERE install_id = ?1 AND kind = 'email_route' ORDER BY name",
    )
      .bind(INSTALL_ID)
      .all<{ name: string; cf_id: string; deleted_at: number | null }>()
  ).results;
}

/** The installed app, whose version receives `emailRouting`, with its records. */
async function seed(emailRouting: CatalogEmailRouting, seedRoutes: () => Promise<void>) {
  const fixture = await buildArtifactFixture({
    catalog: { install: { ...baseCatalog().install, emailRouting } },
  });
  await seedInstall({
    resources: RESOURCES,
    manifestJson: new TextDecoder().decode(fixture.manifestBytes),
  });
  await env.DB.prepare("UPDATE installs SET artifact_url = ?2, artifact_digest = ?3 WHERE id = ?1")
    .bind(INSTALL_ID, ZIP_URL, fixture.digest)
    .run();
  await seedRoutes();
  return fixture;
}

/** What the app's settings show as left out of its email. */
async function leftOut() {
  const settings = await readInstallSettingsCore(
    { db: env.DB, sandboxConnected: false, subdomain: null },
    INSTALL_ID,
  );
  return settings?.email?.again ?? null;
}

/** Starts the job as the app page's confirmation does, with what the settings show. */
async function start(jobId = "job1") {
  const parts = await leftOut();
  if (parts === null) throw new Error("nothing is left out");
  let params: ReconfigureJobParams | null = null;
  await startEmailAgainCore(
    {
      db: env.DB,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => jobId,
    },
    { installId: INSTALL_ID, parts },
  );
  if (params === null) throw new Error("no Workflow params");
  return params as ReconfigureJobParams;
}

async function run(fixture: ArtifactFixture, params: ReconfigureJobParams, email: EmailWorld) {
  const fake = fakeAccount(fixture, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
  });
  const zone = fakeEmailRouting(ACC, email);
  const fetch: FetchLike = async (input, init) =>
    (await zone.handle(new Request(input, init))) ?? fake.fetch(input, init);
  const jobEnv: JobEnv = { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN };
  const step = fakeStep();
  let error: unknown = null;
  try {
    await runReconfigure({
      params,
      step,
      env: { ...jobEnv, SELF: fakeSelf(jobEnv, { fetch }) },
      deps: { fetch, signingKeys: fixture.keys },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT status, error, input_json FROM jobs WHERE id = ?1")
    .bind(params.jobId)
    .first<{ status: string; error: string | null; input_json: string }>();
  const install = await env.DB.prepare("SELECT status FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<{ status: string }>();
  const logs = (
    await env.DB.prepare("SELECT level, message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(params.jobId)
      .all<{ level: string; message: string }>()
  ).results;
  /** Calls that change the zone. */
  const writes = zone.world.calls.filter((c) => !c.startsWith("GET "));
  return { error, job, install, logs, writes, step, fake, world: zone.world };
}

/** The world an update left: routing on, the inbox rule Appflare's, a hand-made rule beside it. */
function world(over: Partial<EmailWorld> = {}): EmailWorld {
  return fakeEmailRouting(ACC, {
    routingEnabled: true,
    rules: [ourRule("rule-inbox", "inbox@example.com"), SALES_RULE],
    ...over,
  }).world;
}

/** Inbox and the routing set up; support and the catch-all left out by the update. */
async function seedLeftOut() {
  return seed({ rules: ["inbox", "support"], catchAll: true }, async () => {
    await seedRoute({ kind: "routing", zoneId: ZONE_ID });
    await seedRoute({ kind: "rule", zoneId: ZONE_ID, ruleId: "rule-inbox" }, "inbox@example.com");
  });
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("setting an app's email up again", () => {
  it("sets up the parts an update left out, deploying nothing", async () => {
    const fixture = await seedLeftOut();
    expect(await leftOut()).toEqual({
      zoneId: ZONE_ID,
      zoneName: "example.com",
      addresses: ["support@example.com"],
      catchAll: true,
      remove: [],
    });
    const params = await start();
    expect(params).toMatchObject({
      kind: "reconfigure",
      emailAgain: true,
      vars: { HOME_PAGE: "admin" },
    });
    const r = await run(fixture, params, world());
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "succeeded", error: null });
    expect(JSON.parse(r.job?.input_json ?? "{}")).toMatchObject({ emailAgain: true, vars: [] });
    expect(r.install?.status).toBe("installed");

    // Support routed to the Worker and the catch-all pointed at it; the
    // hand-made rule and the inbox rule as they were.
    expect(r.world.rules).toEqual([
      ourRule("rule-inbox", "inbox@example.com"),
      SALES_RULE,
      expect.objectContaining({
        matchers: [{ type: "literal", field: "to", value: "support@example.com" }],
        actions: WORKER_ACTION,
      }),
    ]);
    expect(r.world.catchAll).toMatchObject({ enabled: true, actions: WORKER_ACTION });
    const support = r.world.rules[2]?.id ?? "";
    // The catch-all's record keeps the catch-all as it was, for an uninstall to put back.
    expect(await routes()).toEqual([
      {
        name: "*@example.com",
        cf_id: expect.stringMatching(`^catch_all:${ZONE_ID}:`),
        deleted_at: null,
      },
      { name: "example.com", cf_id: `routing:${ZONE_ID}`, deleted_at: null },
      { name: "inbox@example.com", cf_id: `rule:${ZONE_ID}:rule-inbox`, deleted_at: null },
      { name: "support@example.com", cf_id: `rule:${ZONE_ID}:${support}`, deleted_at: null },
    ]);

    // Checked before anything changed; nothing deployed.
    const steps = r.step.names;
    expect(steps.indexOf("check Email Routing on example.com")).toBeLessThan(
      steps.indexOf("route support@example.com to the Worker"),
    );
    expect(steps).not.toContain("record snapshot");
    expect(r.fake.state.versions).toEqual([]);
    expect(r.logs.map((l) => l.message)).toContain(
      "Email Routing on example.com: route support@example.com to the Worker, then send every other address at example.com to the Worker.",
    );
    expect(r.logs.at(-1)?.message).toBe("Set up the email of cut again; it matches version 1.0.0.");

    // Nothing is left out now: the action is gone, and starting it is refused.
    expect(await leftOut()).toBeNull();
    await expect(
      startEmailAgainCore(
        { db: env.DB, createJob: async (id) => ({ id }), newId: () => "job2" },
        {
          installId: INSTALL_ID,
          parts: {
            zoneId: ZONE_ID,
            addresses: ["support@example.com"],
            catchAll: true,
            remove: [],
          },
        },
      ),
    ).rejects.toThrow("Nothing is left out of Cut's email: it is set up as its version asks.");
  });

  it("changes nothing when it runs again once everything is set up", async () => {
    const fixture = await seedLeftOut();
    const params = await start();
    const first = await run(fixture, params, world());
    expect(first.job?.status).toBe("succeeded");

    // The same job again (a second confirmation that raced the first, say).
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('job2', ?1, 'reconfigure', 'queued', '{}')",
      ).bind(INSTALL_ID),
      env.DB.prepare("UPDATE installs SET status = 'updating' WHERE id = ?1").bind(INSTALL_ID),
    ]);
    const again = await run(fixture, { ...params, jobId: "job2" }, { ...first.world, calls: [] });
    expect(again.error).toBeNull();
    expect(again.job).toMatchObject({ status: "succeeded", error: null });
    expect(again.writes).toEqual([]);
    expect(again.world.rules).toEqual(first.world.rules);
    expect(again.logs.map((l) => l.message)).toContain(
      "Email Routing on example.com already matches this version.",
    );
    expect(again.logs.at(-1)?.message).toBe(
      "The email of cut already matches version 1.0.0; nothing was changed.",
    );
  });

  it("refuses, changing nothing, while a rule Appflare did not set up has an address, and names it", async () => {
    const fixture = await seedLeftOut();
    const params = await start();
    const r = await run(
      fixture,
      params,
      world({
        rules: [
          ourRule("rule-inbox", "inbox@example.com"),
          {
            id: "support-forward",
            enabled: true,
            matchers: [{ type: "literal", field: "to", value: "support@example.com" }],
            actions: FORWARD,
          },
        ],
      }),
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain(
      "support@example.com already has a routing rule (forwarding to me@example.net). Appflare does not replace it; delete the rule in the Cloudflare dashboard",
    );
    expect(r.job?.error).toContain("Nothing was changed.");
    expect(r.install?.status).toBe("installed");
    // Strict: not even the catch-all, which nothing was in the way of.
    expect(r.writes).toEqual([]);
    expect(r.world.catchAll).toMatchObject({ enabled: false, actions: [{ type: "drop" }] });
    expect(r.world.rules.map((x) => x.id)).toEqual(["rule-inbox", "support-forward"]);
    expect((await routes()).map((x) => x.name)).toEqual(["example.com", "inbox@example.com"]);
    expect(r.logs.at(-1)).toEqual({
      level: "error",
      message: expect.stringContaining(
        'Setting up the app\'s email again stopped at "check Email Routing on example.com". Nothing Appflare did not set up was changed',
      ),
    });
    // Still left out, so the action stays.
    expect(await leftOut()).not.toBeNull();
  });

  it("refuses while a catch-all Appflare did not set up sends mail elsewhere, and names it", async () => {
    const fixture = await seedLeftOut();
    const params = await start();
    const r = await run(
      fixture,
      params,
      world({ catchAll: { enabled: true, matchers: [{ type: "all" }], actions: FORWARD } }),
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain(
      "The catch-all of example.com already sends mail to forwarding to me@example.net. Appflare does not replace it; turn the catch-all off in the Cloudflare dashboard",
    );
    expect(r.writes).toEqual([]);
    expect(r.world.catchAll).toMatchObject({ enabled: true, actions: FORWARD });
  });

  it("removes only the routes Appflare recorded that the version no longer asks for", async () => {
    // The update to a version without `old` could not delete its rule.
    const fixture = await seed({ rules: ["inbox"], catchAll: false }, async () => {
      await seedRoute({ kind: "routing", zoneId: ZONE_ID });
      await seedRoute({ kind: "rule", zoneId: ZONE_ID, ruleId: "rule-inbox" }, "inbox@example.com");
      await seedRoute({ kind: "rule", zoneId: ZONE_ID, ruleId: "rule-old" }, "old@example.com");
    });
    expect(await leftOut()).toEqual({
      zoneId: ZONE_ID,
      zoneName: "example.com",
      addresses: [],
      catchAll: false,
      remove: [{ kind: "rule", name: "old@example.com" }],
    });
    const params = await start();
    const r = await run(
      fixture,
      params,
      world({
        rules: [
          ourRule("rule-inbox", "inbox@example.com"),
          ourRule("rule-old", "old@example.com"),
          // Made by hand for the Worker, never recorded: not Appflare's to delete.
          ourRule("rule-hand", "hand@example.com"),
          SALES_RULE,
        ],
      }),
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.writes).toEqual([`DELETE /zones/${ZONE_ID}/email/routing/rules/rule-old`]);
    expect(r.world.rules.map((x) => x.id)).toEqual(["rule-inbox", "rule-hand", "sales-rule"]);
    expect(r.world.routingEnabled).toBe(true);
    expect((await routes()).map((x) => ({ name: x.name, removed: x.deleted_at !== null }))).toEqual(
      [
        { name: "example.com", removed: false },
        { name: "inbox@example.com", removed: false },
        { name: "old@example.com", removed: true },
      ],
    );
  });

  it("refuses a confirmation of parts that changed since the page was loaded", async () => {
    await seedLeftOut();
    await expect(
      startEmailAgainCore(
        { db: env.DB, createJob: async (id) => ({ id }), newId: () => "job1" },
        {
          installId: INSTALL_ID,
          parts: {
            zoneId: ZONE_ID,
            addresses: ["support@example.com"],
            catchAll: false,
            remove: [],
          },
        },
      ),
    ).rejects.toThrow(
      "What is left out of the app's email changed since this page was loaded. Reload it to see what setting it up again does now.",
    );
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(jobs?.n).toBe(0);
  });

  it("refuses while another job of the app runs, and offers nothing then", async () => {
    await seedLeftOut();
    await env.DB.prepare("UPDATE installs SET status = 'updating' WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    expect(await leftOut()).toBeNull();
    await expect(
      startEmailAgainCore(
        { db: env.DB, createJob: async (id) => ({ id }), newId: () => "job1" },
        {
          installId: INSTALL_ID,
          parts: {
            zoneId: ZONE_ID,
            addresses: ["support@example.com"],
            catchAll: true,
            remove: [],
          },
        },
      ),
    ).rejects.toThrow("An update, rollback or settings change of this install is running.");
  });

  it("does not read or change a catch-all on record, which the confirmation did not list", async () => {
    // The records say the catch-all is set up; only support is left out.
    const fixture = await seed({ rules: ["inbox", "support"], catchAll: true }, async () => {
      await seedRoute({ kind: "routing", zoneId: ZONE_ID });
      await seedRoute({ kind: "rule", zoneId: ZONE_ID, ruleId: "rule-inbox" }, "inbox@example.com");
      await seedRoute({ kind: "catch_all", zoneId: ZONE_ID, previous: null });
    });
    expect(await leftOut()).toEqual({
      zoneId: ZONE_ID,
      zoneName: "example.com",
      addresses: ["support@example.com"],
      catchAll: false,
      remove: [],
    });
    const params = await start();
    // Something else took the catch-all since: an update would see it, this does not.
    const forwarding = { enabled: true, matchers: [{ type: "all" }], actions: FORWARD };
    const r = await run(fixture, params, world({ catchAll: forwarding }));
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.world.catchAll).toEqual(forwarding);
    expect(r.world.calls.filter((c) => c.includes("catch_all"))).toEqual([]);
    expect(r.writes).toEqual([`POST /zones/${ZONE_ID}/email/routing/rules`]);
  });

  it("sets up on the zone on record when a version without email removed every route", async () => {
    const fixture = await seed({ rules: ["inbox"], catchAll: false }, async () => {
      await seedRoute({ kind: "routing", zoneId: ZONE_ID });
      await seedRoute({ kind: "rule", zoneId: ZONE_ID, ruleId: "rule-inbox" }, "inbox@example.com");
      await env.DB.prepare(
        "UPDATE resources SET deleted_at = 2 WHERE install_id = ?1 AND kind = 'email_route'",
      )
        .bind(INSTALL_ID)
        .run();
    });
    const settings = await readInstallSettingsCore(
      { db: env.DB, sandboxConnected: false, subdomain: null },
      INSTALL_ID,
    );
    // The page names the zone the banner sets up on, not "no record of its domain".
    expect(settings?.email).toEqual({
      zoneId: ZONE_ID,
      zoneName: "example.com",
      leftover: [],
      again: {
        zoneId: ZONE_ID,
        zoneName: "example.com",
        addresses: ["inbox@example.com"],
        catchAll: false,
        remove: [],
      },
    });
    const params = await start();
    const r = await run(fixture, params, world({ rules: [SALES_RULE] }));
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.world.rules.map((x) => x.matchers[0]?.value)).toEqual([
      "sales@example.com",
      "inbox@example.com",
    ]);
    expect(await leftOut()).toBeNull();
  });

  it("takes a rule that already delivers the address to the Worker as the app's", async () => {
    const fixture = await seedLeftOut();
    const params = await start();
    const r = await run(
      fixture,
      params,
      world({
        rules: [
          ourRule("rule-inbox", "inbox@example.com"),
          ourRule("rule-hand", "support@example.com"),
        ],
      }),
    );
    expect(r.job?.status).toBe("succeeded");
    expect(r.world.rules.map((x) => x.id)).toEqual(["rule-inbox", "rule-hand"]);
    expect(r.writes).not.toContain(`POST /zones/${ZONE_ID}/email/routing/rules`);
    expect(await routes()).toContainEqual({
      name: "support@example.com",
      cf_id: `rule:${ZONE_ID}:rule-hand`,
      deleted_at: null,
    });
  });

  it("refuses at a rule to the Worker that is off, as one Appflare did not set up", async () => {
    const fixture = await seedLeftOut();
    const params = await start();
    const off = { ...ourRule("rule-off", "support@example.com"), enabled: false };
    const r = await run(
      fixture,
      params,
      world({ rules: [ourRule("rule-inbox", "inbox@example.com"), off] }),
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain(
      "support@example.com already has a routing rule (the Worker cut, turned off). Appflare does not replace it",
    );
    expect(r.writes).toEqual([]);
  });

  it("refuses, changing nothing, when the zone cannot be read", async () => {
    const fixture = await seedLeftOut();
    const params = await start();
    const r = await run(fixture, params, world({ forbidden: [`/zones/${ZONE_ID}`] }));
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain(
      "Appflare cannot see example.com, the domain the app receives email for: it may have been removed from Cloudflare, or the token lacks Zone: Read.",
    );
    expect(r.job?.error).toContain("Nothing was changed.");
    expect(r.writes).toEqual([]);
    expect(r.install?.status).toBe("installed");
  });

  it("refuses, changing nothing, when the token lacks a permission it needs", async () => {
    const fixture = await seedLeftOut();
    const params = await start();
    const r = await run(
      fixture,
      params,
      world({ forbidden: [`/zones/${ZONE_ID}/email/routing/rules`] }),
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain(
      "the Cloudflare token lacks Email Routing Rules: Edit, which setting up the app's email needs",
    );
    expect(r.job?.error).toContain("Nothing was changed.");
    expect(r.writes).toEqual([]);
  });

  it("refuses to set up the email again together with other changes", async () => {
    const fixture = await seedLeftOut();
    const other: Array<(p: ReconfigureJobParams) => ReconfigureJobParams> = [
      (p) => ({ ...p, emailRouting: { zoneId: ZONE_ID } }),
      (p) => ({ ...p, vars: { ...p.vars, HOME_PAGE: "inbox" } }),
    ];
    for (const [i, change] of other.entries()) {
      const params = change(await start(`job${i + 1}`));
      const r = await run(fixture, params, world());
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toContain(
        "setting up the app's email again changes nothing else; save other changes on their own",
      );
      expect(r.writes).toEqual([]);
      expect(r.fake.state.versions).toEqual([]);
    }
  });

  it("leaves a rule on record that no longer delivers to the Worker, and stops counting it", async () => {
    const fixture = await seed({ rules: ["inbox"], catchAll: false }, async () => {
      await seedRoute({ kind: "routing", zoneId: ZONE_ID });
      await seedRoute({ kind: "rule", zoneId: ZONE_ID, ruleId: "rule-inbox" }, "inbox@example.com");
      await seedRoute({ kind: "rule", zoneId: ZONE_ID, ruleId: "rule-old" }, "old@example.com");
    });
    const params = await start();
    // Changed by hand since Appflare set it up: it forwards now.
    const changed = { ...ourRule("rule-old", "old@example.com"), actions: FORWARD };
    const r = await run(
      fixture,
      params,
      world({ rules: [ourRule("rule-inbox", "inbox@example.com"), changed] }),
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.writes).toEqual([]);
    expect(r.world.rules).toContainEqual(changed);
    expect(r.logs).toContainEqual({
      level: "warn",
      message:
        "The routing rule for old@example.com was changed since Appflare set it up (it is forwarding to me@example.net now), so it was left alone; Appflare no longer counts it as the app's.",
    });
    expect(await routes()).toContainEqual({
      name: "old@example.com",
      cf_id: `rule:${ZONE_ID}:rule-old`,
      deleted_at: expect.any(Number),
    });
    expect(await leftOut()).toBeNull();
  });

  it("offers nothing for an app whose email is set up as its version asks", async () => {
    await seed({ rules: ["inbox"], catchAll: false }, async () => {
      await seedRoute({ kind: "routing", zoneId: ZONE_ID });
      await seedRoute({ kind: "rule", zoneId: ZONE_ID, ruleId: "rule-inbox" }, "inbox@example.com");
    });
    expect(await leftOut()).toBeNull();
  });
});
