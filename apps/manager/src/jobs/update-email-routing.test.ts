import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import type { CatalogEmailRouting } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { describeNeeds } from "../auto-update/cron.server";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  DEFAULT_CATCH_ALL,
  type EmailRouteTarget,
  emailRouteCfId,
  emailRouteKey,
  emailRouteName,
} from "../installs/email-routing";
import {
  listSnapshotsCore,
  startRollbackCore,
  startUpdateCore,
  type UpdateNeeds,
} from "../installs/versions.server";
import { type ArtifactFixture, baseCatalog, buildArtifactFixture } from "../test/artifact-fixture";
import { ACC, fakeAccount, NEW_VERSION, TOKEN } from "../test/fake-account";
import { type EmailWorld, fakeEmailRouting, ZONE_ID } from "../test/fake-email-routing";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import {
  cacheIndex,
  INSTALL_ID,
  OLD_VERSION,
  type SeedResource,
  seedInstall,
} from "../test/seed-install";
import { type RollbackJobParams, runRollback } from "./rollback";
import type { JobEnv } from "./run-job";
import { createJobSteps } from "./steps";
import { runUpdate, type UpdateJobParams } from "./update";
import { changeEmailRoutingPhase, planEmailRoutingChange } from "./update/email-routing";

/**
 * Email Routing across versions, end to end: an install whose version
 * receives some email is updated to a version that receives other email,
 * then rolled back, against the stateful fakes of the account and of one
 * zone's Email Routing, with the local D1.
 */

const RESOURCES: SeedResource[] = [
  { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
  { kind: "worker", name: "cut", cfId: "cut" },
  { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" },
  { kind: "subdomain", name: "cut.appflare-dev.workers.dev" },
];

const jobEnv = (): JobEnv => ({ DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN });

const WORKER_ACTION = [{ type: "worker", value: ["cut"] }];
const FORWARD = [{ type: "forward", value: ["me@example.net"] }];

/** A rule the admin made by hand: never Appflare's to touch. */
const SALES_RULE = {
  id: "sales-rule",
  enabled: true,
  matchers: [{ type: "literal", field: "to", value: "sales@example.com" }],
  actions: FORWARD,
};

/**
 * A version that receives `emailRouting`; with `settings`, a var filled in
 * with the zone. With `mail` (an app of several Workers, `cut-mail` off
 * workers.dev besides the primary one), the Worker its mail goes to: a name
 * of `install.workers`, or null for the primary Worker.
 */
function fixture(
  version: string,
  emailRouting: CatalogEmailRouting | undefined,
  settings = false,
  mail?: string | null,
) {
  const named = mail !== undefined && mail !== null;
  return buildArtifactFixture({
    version,
    ...(mail === undefined
      ? {}
      : {
          otherWorkers: [
            {
              name: "mail",
              workersDev: false,
              bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
            },
          ],
        }),
    catalog: {
      install: {
        ...baseCatalog().install,
        ...(emailRouting === undefined
          ? {}
          : { emailRouting: named ? { ...emailRouting, worker: mail } : emailRouting }),
      },
      ...(settings || named
        ? {
            requires: [
              ...(settings ? ["email-placeholders" as const] : []),
              ...(named ? ["email-worker" as const] : []),
            ],
          }
        : {}),
      ...(settings
        ? {
            vars: [
              { name: "HOME_PAGE", label: "Home page", optional: true },
              { name: "AUTH_FROM", label: "Sender", default: "accounts@{{emailDomain}}" },
            ],
          }
        : {}),
    },
  });
}

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

async function logsOf(jobId: string) {
  return (
    await env.DB.prepare("SELECT level, message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<{ level: string; message: string }>()
  ).results;
}

/** The version `cut-mail` serves before an update, in an app of several Workers. */
const MAIL_OLD = "11111111-2222-4333-8444-555555555555";

/**
 * The account plus the zone's Email Routing, behind one fetch; `cut-mail`,
 * the other Worker of an app of several, has an account fake of its own.
 */
function world(next: ArtifactFixture | null, emailOver: Partial<EmailWorld>) {
  const fake = fakeAccount(next, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
  });
  const mail = fakeAccount(null, {
    worker: "cut-mail",
    deployments: [{ id: "dep-m", versions: [{ version_id: MAIL_OLD, percentage: 100 }] }],
  });
  const email = fakeEmailRouting(ACC, emailOver);
  const fetch: FetchLike = async (input, init) =>
    (await email.handle(new Request(input, init))) ??
    (input.includes("/workers/scripts/cut-mail") ? mail : fake).fetch(input, init);
  return { fake, mail, email, fetch };
}

/**
 * Seeds an install of `installed` (its manifest recorded), runs the update
 * to `next`, then (with `thenRollback`) the rollback to its snapshot.
 */
async function updateThenRollback(input: {
  installed: CatalogEmailRouting | undefined;
  next: CatalogEmailRouting | undefined;
  /** Both versions fill a var in with the zone (`{{emailDomain}}`). */
  settings?: boolean;
  /**
   * Both versions are apps of several Workers; the Worker each has receive
   * its mail (`fixture`'s `mail`).
   */
  mail?: { installed: string | null; next: string | null };
  email: Partial<EmailWorld>;
  /** The routes the install recorded. */
  seed?: () => Promise<void>;
  /** Wraps the fetch (to fail a call). */
  wrap?: (fetch: FetchLike) => FetchLike;
}) {
  const installed = await fixture("1.0.0", input.installed, input.settings, input.mail?.installed);
  const next = await fixture("1.1.0", input.next, input.settings, input.mail?.next);
  const w = world(next, input.email);
  await seedInstall({
    resources: [
      ...RESOURCES,
      ...(input.mail === undefined
        ? []
        : [{ kind: "worker" as const, name: "cut-mail", cfId: "cut-mail" }]),
    ],
    manifestJson: new TextDecoder().decode(installed.manifestBytes),
  });
  await input.seed?.();
  await cacheIndex(next);
  let params: UpdateJobParams | null = null;
  const deps = {
    db: env.DB,
    loadApp: async () => next.index,
    loadManifest: async () => next.manifest,
    createJob: async (_id: string, p: UpdateJobParams) => {
      params = p;
      return { id: "job1" };
    },
    newId: () => "job1",
  };
  // As an update nobody confirmed (the cron, "Update all") asks first.
  const asked = await startUpdateCore(deps, { installId: INSTALL_ID, confirmNoPreview: true });
  const needs = "jobId" in asked ? null : asked;
  if (needs !== null) {
    // A confirmation given for another version (the catalog moved while the dialog was open) counts for nothing.
    const stale = await startUpdateCore(deps, {
      installId: INSTALL_ID,
      confirmNoPreview: true,
      confirmEmailRouting: "1.0.9",
    });
    if ("jobId" in stale) throw new Error("a confirmation of another version started the update");
    await startUpdateCore(deps, {
      installId: INSTALL_ID,
      confirmNoPreview: true,
      confirmEmailRouting: needs.version,
    });
  }
  if (params === null) throw new Error("no update params");
  const fetch = input.wrap?.(w.fetch) ?? w.fetch;
  const self = fakeSelf(jobEnv(), { fetch });
  const step = fakeStep();
  let error: unknown = null;
  try {
    await runUpdate({
      params,
      step,
      env: { ...jobEnv(), SELF: self },
      deps: { fetch, signingKeys: next.keys },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT status, error FROM jobs WHERE id = 'job1'").first<{
    status: string;
    error: string | null;
  }>();
  return { ...w, fetch, self, step, error, job, needs, logs: await logsOf("job1") };
}

async function rollback(fetch: FetchLike) {
  let params: RollbackJobParams | null = null;
  await startRollbackCore(
    {
      db: env.DB,
      createJob: async (_id, p) => {
        params = p;
        return { id: "rb1" };
      },
      newId: () => "rb1",
    },
    { installId: INSTALL_ID, snapshotId: "job1" },
  );
  if (params === null) throw new Error("no rollback params");
  const step = fakeStep();
  let error: unknown = null;
  try {
    await runRollback({ params, step, env: jobEnv(), deps: { fetch } });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT status, error FROM jobs WHERE id = 'rb1'").first<{
    status: string;
    error: string | null;
  }>();
  return { step, error, job, logs: await logsOf("rb1") };
}

/** The install of a version that receives inbox@ only, Email Routing turned on by it. */
async function seedInbox(): Promise<void> {
  await seedRoute({ kind: "routing", zoneId: ZONE_ID });
  await seedRoute({ kind: "rule", zoneId: ZONE_ID, ruleId: "inbox-rule" }, "inbox@example.com");
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("update and rollback of an app that receives email", () => {
  it("adds and removes routing rules and takes the catch-all, and a rollback puts each back", async () => {
    const before = { enabled: false, matchers: [{ type: "all" }], actions: [{ type: "drop" }] };
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: false },
      next: { rules: ["alerts"], catchAll: true },
      email: {
        routingEnabled: true,
        rules: [SALES_RULE, ourRule("inbox-rule", "inbox@example.com")],
        catchAll: before,
      },
      seed: seedInbox,
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    // Nobody saw the change yet: the update waits for an admin, and the dialog says what changes.
    expect(r.needs?.emailRouting).toContain(
      "Version 1.1.0 changes the email the app receives: mail to alerts@example.com starts reaching the app; mail to inbox@example.com stops reaching the app; every other address at example.com starts reaching the app (the catch-all).",
    );
    expect(describeNeeds(r.needs as UpdateNeeds)).toBe("a look at how it changes the app's email");
    const { world } = r.email;
    // The new rule, the catch-all, then the old rule's removal; the admin's rule untouched.
    expect(world.rules.map((x) => x.matchers[0]?.value)).toEqual([
      "sales@example.com",
      "alerts@example.com",
    ]);
    expect(world.rules[0]).toEqual(SALES_RULE);
    expect(world.rules[1]?.actions).toEqual(WORKER_ACTION);
    expect(world.catchAll.actions).toEqual(WORKER_ACTION);
    expect(world.catchAll.enabled).toBe(true);
    expect(world.routingEnabled).toBe(true);
    const names = r.step.names;
    expect(names.indexOf("record promotion")).toBeLessThan(names.indexOf("plan Email Routing"));
    expect(names.indexOf("route alerts@example.com to the Worker")).toBeLessThan(
      names.indexOf("remove email route inbox@example.com"),
    );
    expect(names.indexOf("remove email route inbox@example.com")).toBeLessThan(
      names.indexOf("health check 1"),
    );
    // The check ran through the unit, as an install's does.
    expect(r.self.calls.map((c) => c.unit)).toContain("inspectEmailRouting");
    const alertsId = world.rules[1]?.id ?? "";
    expect(await routes()).toEqual([
      {
        name: "*@example.com",
        cf_id: emailRouteCfId({ kind: "catch_all", zoneId: ZONE_ID, previous: DEFAULT_CATCH_ALL }),
        deleted_at: null,
      },
      { name: "alerts@example.com", cf_id: `rule:${ZONE_ID}:${alertsId}`, deleted_at: null },
      { name: "example.com", cf_id: `routing:${ZONE_ID}`, deleted_at: null },
      {
        name: "inbox@example.com",
        cf_id: `rule:${ZONE_ID}:inbox-rule`,
        deleted_at: expect.any(Number),
      },
    ]);
    expect(r.logs.map((l) => l.message).join("\n")).toContain(
      "Version 1.1.0 changes the email the app receives: mail to alerts starts reaching the app; mail to inbox stops reaching the app; every other address at the app's domain starts reaching the app (the catch-all).",
    );

    // The rollback dialog says what the rollback changes, as the update dialog did.
    const [snapshot] = await listSnapshotsCore(env.DB, INSTALL_ID);
    expect(snapshot?.emailNote).toBe(
      "Version 1.0.0 changes the email the app receives: mail to inbox@example.com starts reaching the app; mail to alerts@example.com stops reaching the app; the catch-all of example.com is put back as it was. Appflare makes the change once the version serves, and never touches a routing rule or catch-all it did not set up. If Email Routing is off for example.com, it is turned on, and Cloudflare adds its MX, SPF and DKIM records.",
    );

    const back = await rollback(r.fetch);
    expect(back.error).toBeNull();
    expect(back.job?.status).toBe("succeeded");
    expect(world.rules.map((x) => x.matchers[0]?.value)).toEqual([
      "sales@example.com",
      "inbox@example.com",
    ]);
    expect(world.rules[0]).toEqual(SALES_RULE);
    // The catch-all as the update found it.
    expect(world.catchAll).toEqual(before);
    expect(world.routingEnabled).toBe(true);
    const inboxId = world.rules[1]?.id ?? "";
    expect(await routes()).toEqual([
      expect.objectContaining({ name: "*@example.com", deleted_at: expect.any(Number) }),
      expect.objectContaining({ name: "alerts@example.com", deleted_at: expect.any(Number) }),
      { name: "example.com", cf_id: `routing:${ZONE_ID}`, deleted_at: null },
      // The record of the rule the update removed is live again, with the new rule.
      { name: "inbox@example.com", cf_id: `rule:${ZONE_ID}:${inboxId}`, deleted_at: null },
    ]);
  });

  it("removes every route of a version without email, turns routing off, and a rollback sets it all up again", async () => {
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: true },
      next: undefined,
      email: {
        routingEnabled: true,
        rules: [ourRule("inbox-rule", "inbox@example.com")],
        catchAll: { enabled: true, matchers: [{ type: "all" }], actions: WORKER_ACTION },
      },
      seed: async () => {
        await seedInbox();
        await seedRoute({ kind: "catch_all", zoneId: ZONE_ID, previous: DEFAULT_CATCH_ALL });
      },
    });
    expect(r.error).toBeNull();
    const { world } = r.email;
    expect(world.rules).toEqual([]);
    expect(world.catchAll).toEqual({
      enabled: false,
      matchers: [{ type: "all" }],
      actions: [{ type: "drop" }],
    });
    // Appflare turned it on and nothing else uses it.
    expect(world.routingEnabled).toBe(false);
    expect((await routes()).every((x) => x.deleted_at !== null)).toBe(true);

    // The removed records still name the zone: the rollback sets it up there again.
    const back = await rollback(r.fetch);
    expect(back.error).toBeNull();
    expect(world.routingEnabled).toBe(true);
    expect(world.rules.map((x) => x.matchers[0]?.value)).toEqual(["inbox@example.com"]);
    expect(world.catchAll.actions).toEqual(WORKER_ACTION);
    expect((await routes()).every((x) => x.deleted_at === null)).toBe(true);
    expect(back.step.names).toContain("make sure Email Routing is on for example.com");
  });

  it("leaves a catch-all and an address that something else uses alone, and sets up the rest", async () => {
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: false },
      next: { rules: ["inbox", "sales", "alerts"], catchAll: true },
      email: {
        routingEnabled: true,
        rules: [SALES_RULE, ourRule("inbox-rule", "inbox@example.com")],
        catchAll: { enabled: true, matchers: [{ type: "all" }], actions: FORWARD },
      },
      seed: seedInbox,
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const { world } = r.email;
    // The catch-all forwards as before: the install asks no consent to replace it, it refuses.
    expect(world.catchAll).toEqual({
      enabled: true,
      matchers: [{ type: "all" }],
      actions: FORWARD,
    });
    expect(world.rules[0]).toEqual(SALES_RULE);
    expect(world.rules.map((x) => x.matchers[0]?.value)).toEqual([
      "sales@example.com",
      "inbox@example.com",
      "alerts@example.com",
    ]);
    const warnings = r.logs.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warnings).toContainEqual(
      expect.stringContaining(
        "sales@example.com already has a routing rule (forwarding to me@example.net). Appflare does not replace it",
      ),
    );
    expect(warnings).toContainEqual(
      expect.stringContaining(
        "The catch-all of example.com already sends mail to forwarding to me@example.net. Appflare does not replace it",
      ),
    );
    expect(warnings.join("\n")).toContain("The next update or rollback of the app sets it up");
    expect((await routes()).map((x) => x.name)).toEqual([
      "alerts@example.com",
      "example.com",
      "inbox@example.com",
    ]);

    // Back to inbox only: the rollback removes alerts@, and still nothing else.
    const back = await rollback(r.fetch);
    expect(back.error).toBeNull();
    expect(world.rules.map((x) => x.matchers[0]?.value)).toEqual([
      "sales@example.com",
      "inbox@example.com",
    ]);
    expect(world.catchAll.actions).toEqual(FORWARD);
  });

  it("asks for a domain in the app's settings when a version first receives email", async () => {
    const r = await updateThenRollback({
      installed: undefined,
      next: { rules: ["inbox"], catchAll: false },
      email: {},
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.email.world.calls).toEqual([]);
    expect(r.logs).toContainEqual({
      level: "warn",
      message: expect.stringContaining(
        "This version receives email, and Appflare has no domain on record for this app to receive it at",
      ),
    });
    expect(r.logs.map((l) => l.message).join("\n")).toContain("Email in the app's settings");
  });

  it("sets the catch-all up again when Appflare recorded it but Cloudflare does not have it", async () => {
    // An earlier job recorded the catch-all before its call, and the call kept failing.
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: true },
      next: { rules: ["inbox"], catchAll: true },
      email: { routingEnabled: true, rules: [ourRule("inbox-rule", "inbox@example.com")] },
      seed: async () => {
        await seedInbox();
        await seedRoute({ kind: "catch_all", zoneId: ZONE_ID, previous: DEFAULT_CATCH_ALL });
      },
    });
    expect(r.error).toBeNull();
    // The same email: no admin needed.
    expect(r.needs).toBeNull();
    expect(r.step.names).toContain("check the catch-all of example.com");
    expect(r.email.world.catchAll).toEqual({
      enabled: true,
      matchers: [{ type: "all" }],
      actions: WORKER_ACTION,
    });
    // The record keeps the catch-all as it was before Appflare first took it.
    expect(await routes()).toContainEqual({
      name: "*@example.com",
      cf_id: emailRouteCfId({ kind: "catch_all", zoneId: ZONE_ID, previous: DEFAULT_CATCH_ALL }),
      deleted_at: null,
    });
  });

  it("does not offer to set up again a catch-all on record that something else took since", async () => {
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: true },
      next: { rules: ["inbox"], catchAll: true },
      email: {
        routingEnabled: true,
        rules: [ourRule("inbox-rule", "inbox@example.com")],
        catchAll: { enabled: true, matchers: [{ type: "all" }], actions: FORWARD },
      },
      seed: async () => {
        await seedInbox();
        await seedRoute({ kind: "catch_all", zoneId: ZONE_ID, previous: DEFAULT_CATCH_ALL });
      },
    });
    expect(r.job?.status).toBe("succeeded");
    expect(r.email.world.catchAll.actions).toEqual(FORWARD);
    const warning = r.logs.find((l) =>
      l.message.startsWith("The catch-all of example.com already sends mail"),
    );
    expect(warning?.message).toContain(
      "The next update or rollback of the app sets it up once that is resolved.",
    );
    // The records still say the catch-all is set up, so the app's settings offer nothing for it.
    expect(warning?.message).not.toContain("Set up email again");
  });

  it("takes an address's rule as its own only when it is on and delivers that address alone", async () => {
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: false },
      next: { rules: ["inbox", "sales", "alerts"], catchAll: false },
      email: {
        routingEnabled: true,
        rules: [
          ourRule("inbox-rule", "inbox@example.com"),
          { ...ourRule("sales-off", "sales@example.com"), enabled: false },
          ourRule("alerts-hand", "alerts@example.com"),
        ],
      },
      seed: seedInbox,
    });
    expect(r.job?.status).toBe("succeeded");
    // Alerts is taken as it is; the rule that is off stays off, and sales is left out.
    expect(r.email.world.rules.map((x) => x.id)).toEqual([
      "inbox-rule",
      "sales-off",
      "alerts-hand",
    ]);
    expect(r.email.world.rules[1]?.enabled).toBe(false);
    expect(r.email.world.calls).not.toContain(`POST /zones/${ZONE_ID}/email/routing/rules`);
    expect(await routes()).toContainEqual({
      name: "alerts@example.com",
      cf_id: `rule:${ZONE_ID}:alerts-hand`,
      deleted_at: null,
    });
    expect((await routes()).map((x) => x.name)).not.toContain("sales@example.com");
    const warnings = r.logs.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warnings).toContainEqual(
      expect.stringContaining(
        "sales@example.com already has a routing rule (the Worker cut, turned off). Appflare does not replace it",
      ),
    );
    expect(warnings.join("\n")).toContain("to set it up sooner, select Set up email again under");
  });

  it("changes nothing for a version that receives the same email", async () => {
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: false },
      next: { rules: ["inbox"], catchAll: false },
      email: { routingEnabled: true, rules: [ourRule("inbox-rule", "inbox@example.com")] },
      seed: seedInbox,
    });
    expect(r.error).toBeNull();
    expect(r.email.world.calls).toEqual([]);
    expect(r.logs.map((l) => l.message)).toContain(
      "Email Routing on example.com already matches this version.",
    );
  });

  it("creates a rule once when the answer to its creation is lost, and runs again without repeating anything", async () => {
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: false },
      next: { rules: ["alerts"], catchAll: false },
      email: {
        routingEnabled: true,
        rules: [ourRule("inbox-rule", "inbox@example.com")],
        failAfter: new Set([
          `POST /zones/${ZONE_ID}/email/routing/rules`,
          `DELETE /zones/${ZONE_ID}/email/routing/rules/inbox-rule`,
        ]),
      },
      seed: seedInbox,
    });
    expect(r.error).toBeNull();
    expect(r.step.retried["route alerts@example.com to the Worker"]).toBe(2);
    expect(r.step.retried["remove email route inbox@example.com"]).toBe(2);
    const { world } = r.email;
    expect(world.rules.map((x) => x.matchers[0]?.value)).toEqual(["alerts@example.com"]);

    // The phase again, as a job that runs after a failure would: nothing is left to do.
    world.calls.length = 0;
    const steps = createJobSteps(
      {
        params: { kind: "update", jobId: "job1" },
        step: fakeStep(),
        env: { ...jobEnv(), SELF: fakeSelf(jobEnv(), { fetch: r.fetch }) },
        deps: { fetch: r.fetch },
      },
      "job1",
    );
    steps.setAccountId(ACC);
    await changeEmailRoutingPhase(steps, {
      installId: INSTALL_ID,
      workerName: "cut",
      target: { rules: ["alerts"], catchAll: false },
    });
    expect(world.calls).toEqual([]);
    expect(world.rules.map((x) => x.matchers[0]?.value)).toEqual(["alerts@example.com"]);
  });

  it("finishes the update when a route cannot be set up, and a rollback finishes from there", async () => {
    let refuse = 10;
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: false },
      next: { rules: ["alerts", "news"], catchAll: false },
      email: { routingEnabled: true, rules: [ourRule("inbox-rule", "inbox@example.com")] },
      seed: seedInbox,
      // Cloudflare fails every creation of the second rule.
      wrap: (fetch) => async (input, init) => {
        if (
          init?.method === "POST" &&
          String(input).endsWith("/email/routing/rules") &&
          String(init.body).includes("news@") &&
          refuse-- > 0
        ) {
          return Response.json(
            { success: false, errors: [{ code: 10013, message: "internal error" }] },
            { status: 500 },
          );
        }
        return fetch(input, init);
      },
    });
    // The version serves: the rest of the update runs, and the log says what is left.
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names).toContain("Email Routing not finished");
    expect(r.step.names.indexOf("Email Routing not finished")).toBeLessThan(
      r.step.names.indexOf("health check 1"),
    );
    expect(r.step.names.at(-1)).toBe("finish");
    expect(r.logs).toContainEqual({
      level: "warn",
      message: expect.stringContaining("the next update or rollback of the app finishes the rest"),
    });
    const { world } = r.email;
    // What was done is recorded; the old rule is still there (removals follow additions).
    expect(world.rules.map((x) => x.matchers[0]?.value)).toEqual([
      "inbox@example.com",
      "alerts@example.com",
    ]);
    expect((await routes()).filter((x) => x.deleted_at === null).map((x) => x.name)).toEqual([
      "alerts@example.com",
      "example.com",
      "inbox@example.com",
    ]);
    // The rollback reads the records again: alerts@ goes, inbox@ stays, nothing twice.
    const back = await rollback(r.fetch);
    expect(back.error).toBeNull();
    expect(world.rules.map((x) => x.matchers[0]?.value)).toEqual(["inbox@example.com"]);
    expect(world.rules[0]?.id).toBe("inbox-rule");
  });

  it("keeps a route it is not allowed to remove, and says so", async () => {
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: false },
      next: { rules: ["alerts"], catchAll: false },
      email: {
        routingEnabled: true,
        rules: [ourRule("inbox-rule", "inbox@example.com")],
        forbidden: [`/zones/${ZONE_ID}/email/routing/rules/inbox-rule`],
      },
      seed: seedInbox,
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.email.world.rules.map((x) => x.matchers[0]?.value)).toEqual([
      "inbox@example.com",
      "alerts@example.com",
    ]);
    const warning = r.logs.find((l) => l.message.startsWith("Appflare could not finish"));
    expect(warning?.message).toContain("Cloudflare refused to delete the routing rule");
    expect(warning?.message).toContain("let the next update or rollback of the app finish");
    // Still recorded, so the next job removes it.
    expect(await routes()).toContainEqual(
      expect.objectContaining({ name: "inbox@example.com", deleted_at: null }),
    );
  });

  it("removes routes on record even when the installed version's manifest names no email", async () => {
    const r = await updateThenRollback({
      installed: undefined,
      next: undefined,
      email: { routingEnabled: true, rules: [ourRule("inbox-rule", "inbox@example.com")] },
      seed: seedInbox,
    });
    expect(r.error).toBeNull();
    expect(r.needs).toBeNull();
    expect(r.email.world.rules).toEqual([]);
    expect(r.email.world.routingEnabled).toBe(false);
    expect((await routes()).every((x) => x.deleted_at !== null)).toBe(true);
  });

  it("stays the one to turn routing off when something else still uses it", async () => {
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: false },
      next: undefined,
      email: {
        routingEnabled: true,
        rules: [SALES_RULE, ourRule("inbox-rule", "inbox@example.com")],
      },
      seed: seedInbox,
    });
    expect(r.error).toBeNull();
    const { world } = r.email;
    expect(world.routingEnabled).toBe(true);
    expect(world.rules).toEqual([SALES_RULE]);
    // The record that Appflare turned routing on stays live; the rule's goes.
    expect(await routes()).toEqual([
      { name: "example.com", cf_id: `routing:${ZONE_ID}`, deleted_at: null },
      expect.objectContaining({ name: "inbox@example.com", deleted_at: expect.any(Number) }),
    ]);
    const back = await rollback(r.fetch);
    expect(back.error).toBeNull();
    expect(world.rules.map((x) => x.matchers[0]?.value)).toEqual([
      "sales@example.com",
      "inbox@example.com",
    ]);
    expect((await routes()).every((x) => x.deleted_at === null)).toBe(true);
  });

  it("points to the app's settings when the zone cannot be seen any more", async () => {
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: false },
      next: { rules: ["alerts"], catchAll: false },
      email: {
        routingEnabled: true,
        rules: [ourRule("inbox-rule", "inbox@example.com")],
        forbidden: [`/zones/${ZONE_ID}`],
      },
      seed: seedInbox,
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const warnings = r.logs.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warnings).toContainEqual(
      expect.stringContaining(
        "Appflare cannot see example.com, the domain the app receives email for",
      ),
    );
    expect(warnings.join("\n")).toContain("Email in the app's settings");
  });
});

describe("planEmailRoutingChange", () => {
  const row = (
    target: EmailRouteTarget,
    name: string,
    over: { createdAt?: number; deleted?: boolean } = {},
  ) => ({
    id: `i1:email_route:${name}`,
    name,
    cfId: emailRouteCfId(target),
    createdAt: over.createdAt ?? 1,
    deleted: over.deleted ?? false,
  });
  const zone = "z1";

  it("compares only the current zone, and refuses addresses outside it", () => {
    const plan = planEmailRoutingChange(
      { rules: ["a", "b@other.com"], catchAll: false },
      [
        row({ kind: "rule", zoneId: "old", ruleId: "r0" }, "x@old.com", { createdAt: 1 }),
        row({ kind: "rule", zoneId: zone, ruleId: "r1" }, "c@example.com", { createdAt: 2 }),
      ],
      "i1",
    );
    expect(plan.zone).toEqual({ zoneId: zone, zoneName: "example.com" });
    expect(plan.addresses).toEqual(["a@example.com"]);
    expect(plan.remove.map((r) => r.name)).toEqual(["c@example.com"]);
    expect(plan.refused).toEqual([
      expect.stringContaining("b@other.com, which is not an address at example.com"),
    ]);
  });

  it("remembers the zone from removed records, and asks for one without any", () => {
    const remembered = planEmailRoutingChange(
      { rules: ["a"], catchAll: true },
      [row({ kind: "rule", zoneId: zone, ruleId: "r1" }, "a@example.com", { deleted: true })],
      "i1",
    );
    expect(remembered).toMatchObject({
      zone: { zoneId: zone, zoneName: "example.com" },
      addresses: ["a@example.com"],
      catchAll: true,
      remove: [],
      refused: [],
    });
    expect(planEmailRoutingChange({ rules: ["a"], catchAll: false }, [], "i1").refused).toEqual([
      expect.stringContaining("Appflare has no domain on record"),
    ]);
    // No email and no records: nothing at all.
    expect(planEmailRoutingChange(null, [], "i1")).toMatchObject({ remove: [], refused: [] });
  });
});

describe("an app of several Workers whose mail goes to another of them", () => {
  const MAIL = [{ type: "worker", value: ["cut-mail"] }];
  /** The rule and catch-all an install of a version whose primary Worker received the mail left. */
  const primaryRoutes = (): Partial<EmailWorld> => ({
    routingEnabled: true,
    rules: [SALES_RULE, ourRule("inbox-rule", "inbox@example.com")],
    catchAll: { enabled: true, matchers: [{ type: "all" }], actions: WORKER_ACTION },
  });

  async function seedRoutes(): Promise<void> {
    await seedInbox();
    await seedRoute({ kind: "catch_all", zoneId: ZONE_ID, previous: DEFAULT_CATCH_ALL });
  }

  /** The update's or rollback's email phase, moving the mail to `workerName`. */
  async function change(
    email: Partial<EmailWorld>,
    request: { workerName: string; target: CatalogEmailRouting | null },
  ) {
    await seedInstall({ resources: RESOURCES });
    await seedRoutes();
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('job1', ?1, 'update', 'running', '{}')",
    )
      .bind(INSTALL_ID)
      .run();
    const w = world(null, email);
    const step = fakeStep();
    const steps = createJobSteps(
      {
        params: { kind: "update", jobId: "job1" },
        step,
        env: { ...jobEnv(), SELF: fakeSelf(jobEnv(), { fetch: w.fetch }) },
        deps: { fetch: w.fetch },
      },
      "job1",
    );
    steps.setAccountId(ACC);
    await changeEmailRoutingPhase(steps, {
      installId: INSTALL_ID,
      ...request,
      // The app's Workers, as the update and rollback jobs list them.
      otherWorkers: ["cut", "cut-mail"],
    });
    return { ...w, step, logs: await logsOf("job1") };
  }

  it("points the rules and catch-all it keeps at the Worker that receives the version's mail", async () => {
    const r = await change(primaryRoutes(), {
      workerName: "cut-mail",
      target: { rules: ["inbox"], catchAll: true },
    });
    const { world } = r.email;
    // In place: the rule keeps its id, so the install's record stays true.
    expect(world.rules).toEqual([
      SALES_RULE,
      {
        id: "inbox-rule",
        name: "cut-mail (installed by Appflare)",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "inbox@example.com" }],
        actions: MAIL,
      },
    ]);
    expect(world.catchAll).toEqual({ enabled: true, matchers: [{ type: "all" }], actions: MAIL });
    expect(r.step.names).toContain('point inbox@example.com at the Worker "cut-mail"');
    // Nothing removed or recreated, and no rule is in the way of itself.
    expect(world.calls.filter((c) => c.startsWith("DELETE") || c.startsWith("POST"))).toEqual([]);
    expect((await routes()).every((x) => x.deleted_at === null)).toBe(true);
    expect(r.logs.map((l) => l.message)).toContain(
      'Mail to inbox@example.com now goes to the Worker "cut-mail", which receives this version\'s mail (it went to "cut").',
    );
  });

  it("points them back on a rollback to a version whose primary Worker receives the mail", async () => {
    const moved = primaryRoutes();
    moved.rules = [SALES_RULE, { ...ourRule("inbox-rule", "inbox@example.com"), actions: MAIL }];
    moved.catchAll = { enabled: true, matchers: [{ type: "all" }], actions: MAIL };
    const r = await change(moved, {
      workerName: "cut",
      target: { rules: ["inbox"], catchAll: true },
    });
    const { world } = r.email;
    expect(world.rules[1]?.actions).toEqual(WORKER_ACTION);
    expect(world.rules[1]?.id).toBe("inbox-rule");
    expect(world.catchAll.actions).toEqual(WORKER_ACTION);
    expect(world.rules[0]).toEqual(SALES_RULE);
  });

  it("puts the catch-all back from another of the app's Workers when the version drops it", async () => {
    const moved = primaryRoutes();
    moved.rules = [SALES_RULE, { ...ourRule("inbox-rule", "inbox@example.com"), actions: MAIL }];
    moved.catchAll = { enabled: true, matchers: [{ type: "all" }], actions: MAIL };
    const r = await change(moved, {
      workerName: "cut",
      target: { rules: ["inbox"], catchAll: false },
    });
    expect(r.email.world.catchAll).toEqual({
      enabled: false,
      matchers: [{ type: "all" }],
      actions: [{ type: "drop" }],
    });
    expect(r.email.world.rules[1]?.actions).toEqual(WORKER_ACTION);
  });

  it("sets a rule deleted by hand up again, and leaves one changed by hand alone", async () => {
    const changed = primaryRoutes();
    changed.rules = [SALES_RULE];
    const gone = await change(changed, {
      workerName: "cut-mail",
      target: { rules: ["inbox"], catchAll: true },
    });
    expect(gone.email.world.rules.map((x) => [x.matchers[0]?.value, x.actions])).toEqual([
      ["sales@example.com", FORWARD],
      ["inbox@example.com", MAIL],
    ]);

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    const forwarded = primaryRoutes();
    forwarded.rules = [
      SALES_RULE,
      { ...ourRule("inbox-rule", "inbox@example.com"), actions: FORWARD },
    ];
    const r = await change(forwarded, {
      workerName: "cut-mail",
      target: { rules: ["inbox"], catchAll: true },
    });
    expect(r.email.world.rules[1]?.actions).toEqual(FORWARD);
    expect(r.logs.map((l) => `${l.level} ${l.message}`)).toContain(
      'warn The routing rule for inbox@example.com was changed since Appflare set it up (it is forwarding to me@example.net now), so it was left alone and mail to inbox@example.com does not reach the Worker "cut-mail".',
    );
  });
});

describe("an update and a rollback across a change of the Worker that receives the mail", () => {
  const MAIL = [{ type: "worker", value: ["cut-mail"] }];
  /** The rule and catch-all an install of 1.0.0 left, delivering to the primary Worker. */
  const installedRoutes = (): Partial<EmailWorld> => ({
    routingEnabled: true,
    rules: [SALES_RULE, ourRule("inbox-rule", "inbox@example.com")],
    catchAll: { enabled: true, matchers: [{ type: "all" }], actions: WORKER_ACTION },
  });
  const seed = async () => {
    await seedInbox();
    await seedRoute({ kind: "catch_all", zoneId: ZONE_ID, previous: DEFAULT_CATCH_ALL });
  };
  /** 1.0.0 has its primary Worker receive the mail; 1.1.0 names `mail`. */
  const moveToMail = () =>
    updateThenRollback({
      installed: { rules: ["inbox"], catchAll: true },
      next: { rules: ["inbox"], catchAll: true },
      mail: { installed: null, next: "mail" },
      email: installedRoutes(),
      seed,
    });

  it("points the rule and catch-all at the Worker the new version names, on update", async () => {
    const r = await moveToMail();
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const { world } = r.email;
    expect(world.rules).toEqual([
      SALES_RULE,
      {
        id: "inbox-rule",
        name: "cut-mail (installed by Appflare)",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "inbox@example.com" }],
        actions: MAIL,
      },
    ]);
    expect(world.catchAll).toEqual({ enabled: true, matchers: [{ type: "all" }], actions: MAIL });
    expect((await routes()).every((x) => x.deleted_at === null)).toBe(true);
  });

  it("points them back at the primary Worker on a rollback to the version before", async () => {
    const r = await moveToMail();
    expect(r.job?.status).toBe("succeeded");
    const back = await rollback(r.fetch);
    expect(back.error).toBeNull();
    expect(back.job?.status).toBe("succeeded");
    // Both Workers serve the snapshot's versions again.
    expect(r.mail.state.deployments[0]?.versions).toEqual([
      { version_id: MAIL_OLD, percentage: 100 },
    ]);
    const { world } = r.email;
    expect(world.rules).toEqual([
      SALES_RULE,
      {
        id: "inbox-rule",
        name: "cut (installed by Appflare)",
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "inbox@example.com" }],
        actions: WORKER_ACTION,
      },
    ]);
    expect(world.catchAll).toEqual({
      enabled: true,
      matchers: [{ type: "all" }],
      actions: WORKER_ACTION,
    });
    expect(back.step.names).toContain('point inbox@example.com at the Worker "cut"');
  });
});

describe("an update of an app whose settings use its email zone", () => {
  it("fills {{emailDomain}} in with the zone on record", async () => {
    const r = await updateThenRollback({
      installed: { rules: ["inbox"], catchAll: false },
      next: { rules: ["inbox"], catchAll: false },
      settings: true,
      email: { routingEnabled: true, rules: [ourRule("inbox-rule", "inbox@example.com")] },
      seed: seedInbox,
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const uploaded = r.fake.state.versions.at(-1)?.metadata.bindings as unknown[];
    expect(uploaded).toContainEqual({
      type: "plain_text",
      name: "AUTH_FROM",
      text: "accounts@example.com",
    });
  });
});

describe("a rollback of an app whose settings use its email zone", () => {
  /**
   * 1.1.0 serves, its email on example.com (the records say so); the
   * snapshot's 1.0.0 version was uploaded with `deployedWith` as the sender,
   * filled in with the zone the email was on then. A rollback does not move
   * the email back, so the old version's settings may name a zone the app
   * no longer receives email for.
   */
  async function rollbackTo(deployedWith: string) {
    const old = await fixture("1.0.0", { rules: ["inbox"], catchAll: false }, true);
    const current = await fixture("1.1.0", { rules: ["inbox"], catchAll: false }, true);
    await seedInstall({
      version: "1.1.0",
      currentVersionId: NEW_VERSION,
      manifestJson: new TextDecoder().decode(current.manifestBytes),
      resources: RESOURCES,
    });
    await seedInbox();
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, worker_version_id) VALUES ('job1', ?1, 'reconfigure', 'succeeded', ?2)",
    )
      .bind(INSTALL_ID, NEW_VERSION)
      .run();
    await env.DB.prepare(
      `INSERT INTO snapshots (id, install_id, job_id, worker_version_id, d1_bookmarks_json, taken_at,
         catalog_version, manifest_json, artifact_url, artifact_digest, pin_sha, do_migration_tag,
         target_catalog_version, config_json)
       VALUES ('job1', ?1, 'job1', ?2, '{}', 1000, '1.0.0', ?3,
         'https://artifacts.test/cut/old.zip', ?4, 'oldsha', NULL, '1.1.0', '{}')`,
    )
      .bind(INSTALL_ID, OLD_VERSION, new TextDecoder().decode(old.manifestBytes), old.digest)
      .run();
    const fake = fakeAccount(null, {
      deployments: [
        { id: "dep-2", versions: [{ version_id: NEW_VERSION, percentage: 100 }] },
        { id: "dep-1", versions: [{ version_id: OLD_VERSION, percentage: 100 }] },
      ],
      versionBindings: {
        [OLD_VERSION]: [
          { type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-1" },
          { type: "plain_text", name: "AUTH_FROM", text: deployedWith },
        ],
      },
    });
    const email = fakeEmailRouting(ACC, {
      routingEnabled: true,
      rules: [ourRule("inbox-rule", "inbox@example.com")],
    });
    const fetch: FetchLike = async (input, init) =>
      (await email.handle(new Request(input, init))) ?? fake.fetch(input, init);
    let params: RollbackJobParams | null = null;
    await startRollbackCore(
      {
        db: env.DB,
        createJob: async (_id, p) => {
          params = p;
          return { id: "rb1" };
        },
        newId: () => "rb1",
      },
      { installId: INSTALL_ID, snapshotId: "job1" },
    );
    if (params === null) throw new Error("no rollback params");
    const created: Array<{ id: string; params: unknown }> = [];
    const JOBS = {
      create: async (o: { id: string; params: unknown }) => {
        created.push(o);
        return { id: o.id };
      },
    } as NonNullable<JobEnv["JOBS"]>;
    let error: unknown = null;
    try {
      await runRollback({ params, step: fakeStep(), env: { ...jobEnv(), JOBS }, deps: { fetch } });
    } catch (e) {
      error = e;
    }
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = 'rb1'").first<{
      status: string;
    }>();
    return { error, job, created, logs: (await logsOf("rb1")).map((l) => l.message) };
  }

  it("deploys the settings again with the zone the app receives email for now", async () => {
    const r = await rollbackTo("accounts@old-zone.example");
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.created).toHaveLength(1);
    expect(r.created[0]?.params).toMatchObject({
      kind: "reconfigure",
      installId: INSTALL_ID,
      refreshVars: ["emailZone"],
    });
    expect(r.logs.at(-1)).toContain(
      "This version's settings were filled in with another email domain ({{emailDomain}}) than the app has now, so a settings change (job ",
    );
  });

  it("leaves the settings alone when the version names the zone on record", async () => {
    const r = await rollbackTo("accounts@example.com");
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.created).toEqual([]);
  });
});
