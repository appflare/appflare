import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { setUpGatewayCore } from "../../gateway/gateway.server";
import type { InstallDomainInput } from "../../installs/install-input";
import { accessChallenge } from "../../test/access-sign-in";
import { ACC, TOKEN } from "../../test/fake-account";
import { fakeSaas, GATEWAY_ZONE } from "../../test/fake-saas";
import { fakeSelf } from "../../test/fake-self";
import { fakeStep } from "../../test/fake-step";
import { INSTALL_ID, seedInstall } from "../../test/seed-install";
import { createJobSteps } from "../steps";
import { CUSTOM_DOMAIN_MAX_PROBES, EXTERNAL_DOMAIN_MAX_POLLS } from "../units/domains";
import { installDomainPhase } from "./domain";

/**
 * The install job's domain step against the local D1 and the SaaS fake,
 * with the units run through a fake `SELF`.
 */

const JOB = "job-domain";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
  await env.DB.prepare(
    "INSERT INTO jobs (id, install_id, kind, status) VALUES (?1, ?2, 'install', 'running')",
  )
    .bind(JOB, INSTALL_ID)
    .run();
});

async function run(
  domain: InstallDomainInput,
  saas: ReturnType<typeof fakeSaas>,
  opts: { settingsUseWorkerUrl?: boolean; answer?: () => Response } = {},
) {
  const probes: string[] = [];
  const subdomainCalls: unknown[] = [];
  // The app answers on its domain; the subdomain call and the custom domains
  // API are faked here; everything else is the SaaS fake.
  const fetch: FetchLike = async (input, init) => {
    if (input.startsWith("https://api.cloudflare.com/")) {
      const path = new URL(input).pathname;
      if (path.endsWith("/workers/scripts/cut/subdomain")) {
        subdomainCalls.push(JSON.parse(String(init?.body)));
        return Response.json({ success: true, errors: [], messages: [], result: {} });
      }
      if (path.endsWith("/workers/domains")) return customDomains(init);
      return saas.fetch(input, init);
    }
    probes.push(input);
    return opts.answer?.() ?? new Response("<html>cut</html>");
  };
  const unitEnv = { CF_API_TOKEN: TOKEN };
  const self = fakeSelf(unitEnv, { fetch, sleep: async () => {} });
  const step = fakeStep();
  const steps = createJobSteps(
    {
      params: { kind: "install", jobId: JOB },
      step,
      env: { DB: env.DB, CF_API_TOKEN: TOKEN, SELF: self },
      deps: { fetch, sleep: async () => {} },
    },
    JOB,
  );
  steps.setAccountId(ACC);
  const { servedBy } = await installDomainPhase(steps, {
    db: env.DB,
    installId: INSTALL_ID,
    workerName: "cut",
    domain,
    health: { path: "/", mode: "no-server-errors" },
    settingsUseWorkerUrl: opts.settingsUseWorkerUrl ?? false,
  });
  const logs = (
    await env.DB.prepare("SELECT level, message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(JOB)
      .all<{ level: string; message: string }>()
  ).results;
  const rows = (
    await env.DB.prepare(
      "SELECT kind, binding, name, cf_id FROM resources WHERE install_id = ?1 AND kind IN ('domain', 'custom_hostname')",
    )
      .bind(INSTALL_ID)
      .all()
  ).results;
  return { step, self, logs, rows, probes, subdomainCalls, servedBy };
}

/** The Workers custom domains API: nothing attached yet, and every attach succeeds. */
async function customDomains(init?: RequestInit): Promise<Response> {
  const result =
    init?.method === "PUT"
      ? { id: "cfd-1", ...(JSON.parse(String(init.body)) as object), zone_name: "own.example" }
      : [];
  return Response.json({ success: true, errors: [], messages: [], result });
}

async function installRow() {
  return env.DB.prepare(
    "SELECT workers_dev_enabled, workers_dev_choice, served_domain FROM installs WHERE id = ?1",
  )
    .bind(INSTALL_ID)
    .first();
}

async function liveDomains() {
  return (
    await env.DB.prepare(
      "SELECT name FROM resources WHERE install_id = ?1 AND live_at IS NOT NULL ORDER BY rowid",
    )
      .bind(INSTALL_ID)
      .all<{ name: string }>()
  ).results.map((r) => r.name);
}

async function gateway() {
  const saas = fakeSaas();
  await setUpGatewayCore(
    { db: env.DB, api: saas.api, sleep: async () => {} },
    {
      zoneId: GATEWAY_ZONE.id,
    },
  );
  return saas;
}

describe("installDomainPhase", () => {
  it("adds an external domain, waits for it, and probes the app through it", async () => {
    const saas = await gateway();
    // The owner's CNAME was there before the install: it goes active at once.
    const realFetch = saas.fetch;
    saas.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      if (input.includes("/custom_hostnames/ch-")) saas.activate("go.customer.test");
      return response;
    };
    const r = await run(
      { kind: "external", hostname: "go.customer.test", validation: "http" },
      saas,
    );
    expect(r.step.names).toEqual([
      "add external domain go.customer.test",
      "wait for go.customer.test",
      "go.customer.test is live",
    ]);
    expect(r.self.calls.map((c) => c.unit)).toEqual(["attachDomain", "waitForExternalDomain"]);
    // The app answers through the domain: workers.dev goes off, previews stay on.
    expect(r.subdomainCalls).toEqual([{ enabled: false, previews_enabled: true }]);
    expect(await installRow()).toEqual({
      workers_dev_enabled: 0,
      workers_dev_choice: "auto",
      served_domain: "go.customer.test",
    });
    expect(await liveDomains()).toEqual(["go.customer.test"]);
    expect(r.servedBy).toBe("go.customer.test");
    expect(r.rows).toEqual([
      {
        kind: "custom_hostname",
        binding: "APP_I1",
        name: "go.customer.test",
        cf_id: `${GATEWAY_ZONE.id}/${saas.world.hostnames[0]?.id}`,
      },
    ]);
    expect(r.probes).toEqual(["https://go.customer.test/"]);
    expect(r.logs.some((l) => l.message.includes("is active with its certificate"))).toBe(true);
  });

  it("lists the records to add when the domain is still pending, without failing", async () => {
    const saas = await gateway();
    const r = await run(
      { kind: "external", hostname: "go.customer.test", validation: "http" },
      saas,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.probes).toEqual([]);
    // Not live: workers.dev stays the app's address.
    expect(r.subdomainCalls).toEqual([]);
    expect(await installRow()).toMatchObject({ workers_dev_enabled: 1, served_domain: null });
    expect(await liveDomains()).toEqual([]);
    const waited = saas.world.calls.filter((c) =>
      c.startsWith("GET /zones/z-gw/custom_hostnames/ch-"),
    );
    expect(waited).toHaveLength(EXTERNAL_DOMAIN_MAX_POLLS);
    expect(
      r.logs.some(
        (l) =>
          l.message.includes("still waiting for its DNS records") &&
          l.message.includes(`CNAME go.customer.test -> appflare-gateway.${GATEWAY_ZONE.name}`),
      ),
    ).toBe(true);
  });

  it("reports a refused external domain as a warning, not a failure", async () => {
    const saas = await gateway();
    const r = await run(
      { kind: "external", hostname: "app.own.example", validation: "http" },
      saas,
    );
    // The claim is given up: nothing stays recorded.
    const live = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM resources WHERE install_id = ?1 AND kind = 'custom_hostname' AND deleted_at IS NULL",
    )
      .bind(INSTALL_ID)
      .first<{ n: number }>();
    expect(live?.n).toBe(0);
    expect(r.step.names).toEqual(["add external domain app.own.example"]);
    expect(r.logs.at(-1)).toMatchObject({ level: "warn" });
    expect(r.logs.at(-1)?.message).toContain("Add it as a custom domain instead");
  });

  it("refuses a hostname another app has, before creating anything", async () => {
    const saas = await gateway();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
           artifact_url, status, installed_at, updated_at)
         VALUES ('i2', 'blog', 'blog', 'blog', '1.0.0', 'u', 'installed', 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES ('r2', 'i2', 'custom_hostname', 'APP_I2', 'go.customer.test', 'z-gw/ch-x', 1)`,
      ),
    ]);
    const r = await run(
      { kind: "external", hostname: "go.customer.test", validation: "http" },
      saas,
    );
    expect(r.rows).toEqual([]);
    expect(r.self.calls).toEqual([]);
    expect(saas.world.hostnames).toEqual([]);
    expect(r.logs.at(-1)?.message).toContain("already a domain of another app");
  });

  it("attaches a custom domain, waits until the app answers there, then turns workers.dev off", async () => {
    const saas = fakeSaas();
    let answers = 0;
    const r = await run({ kind: "custom", zoneId: "z-own", hostname: "app.own.example" }, saas, {
      // The certificate takes two probes to arrive.
      answer: () =>
        ++answers < 3
          ? new Response("error code: 526", { status: 526 })
          : new Response("<html>cut</html>"),
    });
    expect(r.step.names).toEqual([
      "add custom domain app.own.example",
      "wait for app.own.example",
      "app.own.example is live",
    ]);
    expect(r.self.calls.map((c) => c.unit)).toEqual(["attachDomain", "waitForCustomDomain"]);
    expect(r.probes).toEqual([
      "https://app.own.example/",
      "https://app.own.example/",
      "https://app.own.example/",
    ]);
    expect(r.subdomainCalls).toEqual([{ enabled: false, previews_enabled: true }]);
    expect(await installRow()).toMatchObject({
      workers_dev_enabled: 0,
      served_domain: "app.own.example",
    });
    expect(await liveDomains()).toEqual(["app.own.example"]);
    expect(r.logs.some((l) => l.message.startsWith("Turned off the workers.dev URL"))).toBe(true);
  });

  it("leaves workers.dev on while a custom domain never reaches the app", async () => {
    const saas = fakeSaas();
    const r = await run({ kind: "custom", zoneId: "z-own", hostname: "app.own.example" }, saas, {
      answer: () => new Response("error code: 526", { status: 526 }),
    });
    expect(r.step.names).toEqual(["add custom domain app.own.example", "wait for app.own.example"]);
    expect(r.probes).toHaveLength(CUSTOM_DOMAIN_MAX_PROBES);
    expect(r.subdomainCalls).toEqual([]);
    expect(await installRow()).toMatchObject({ workers_dev_enabled: 1 });
    expect(await liveDomains()).toEqual([]);
    expect(r.servedBy).toBeNull();
  });

  it("counts a custom domain where Cloudflare Access answers as live, and turns workers.dev off", async () => {
    const saas = fakeSaas();
    const r = await run({ kind: "custom", zoneId: "z-own", hostname: "app.own.example" }, saas, {
      answer: () => accessChallenge("app.own.example"),
    });
    expect(r.step.names).toEqual([
      "add custom domain app.own.example",
      "wait for app.own.example",
      "app.own.example is live",
    ]);
    expect(r.probes).toEqual(["https://app.own.example/"]);
    expect(r.subdomainCalls).toEqual([{ enabled: false, previews_enabled: true }]);
    expect(await installRow()).toMatchObject({
      workers_dev_enabled: 0,
      served_domain: "app.own.example",
    });
    expect(await liveDomains()).toEqual(["app.own.example"]);
    expect(r.servedBy).toBe("app.own.example");
    expect(r.logs.map((l) => l.message)).toContain(
      "https://app.own.example/: Live behind Cloudflare Access. Access answered with its sign-in page, so Appflare can't check the app itself through this domain.",
    );
  });

  it("counts an active external domain where Cloudflare Access answers as live", async () => {
    const saas = await gateway();
    const realFetch = saas.fetch;
    saas.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      if (input.includes("/custom_hostnames/ch-")) saas.activate("go.customer.test");
      return response;
    };
    const r = await run(
      { kind: "external", hostname: "go.customer.test", validation: "http" },
      saas,
      { answer: () => accessChallenge("go.customer.test") },
    );
    expect(r.step.names).toEqual([
      "add external domain go.customer.test",
      "wait for go.customer.test",
      "go.customer.test is live",
    ]);
    expect(r.probes).toEqual(["https://go.customer.test/"]);
    expect(r.subdomainCalls).toEqual([{ enabled: false, previews_enabled: true }]);
    expect(await installRow()).toMatchObject({
      workers_dev_enabled: 0,
      served_domain: "go.customer.test",
    });
    expect(await liveDomains()).toEqual(["go.customer.test"]);
    expect(r.servedBy).toBe("go.customer.test");
    expect(r.logs.map((l) => l.message)).toContain(
      "go.customer.test is active with its certificate. Live behind Cloudflare Access. Access answered with its sign-in page, so Appflare can't check the app itself through this domain.",
    );
  });

  it("keeps workers.dev on when the app's settings use its workers.dev URL", async () => {
    const saas = fakeSaas();
    const r = await run({ kind: "custom", zoneId: "z-own", hostname: "app.own.example" }, saas, {
      settingsUseWorkerUrl: true,
    });
    expect(r.subdomainCalls).toEqual([]);
    expect(await installRow()).toMatchObject({ workers_dev_enabled: 1, served_domain: null });
    // Live all the same: it is where the app opens.
    expect(await liveDomains()).toEqual(["app.own.example"]);
    expect(r.logs.at(-1)?.message).toContain("stays on because the app's settings use it");
  });

  it("keeps workers.dev as an admin set it", async () => {
    await env.DB.prepare("UPDATE installs SET workers_dev_choice = 'manual'").run();
    const saas = fakeSaas();
    const r = await run({ kind: "custom", zoneId: "z-own", hostname: "app.own.example" }, saas);
    expect(r.subdomainCalls).toEqual([]);
    expect(await installRow()).toMatchObject({ workers_dev_enabled: 1 });
    expect(r.logs.at(-1)?.message).toContain("stays as an admin set it");
  });

  it("skips an external domain when the gateway is gone", async () => {
    const saas = fakeSaas();
    const r = await run(
      { kind: "external", hostname: "go.customer.test", validation: "http" },
      saas,
    );
    expect(r.rows).toEqual([]);
    expect(r.self.calls).toEqual([]);
    expect(r.logs.at(-1)?.message).toContain("gateway is not set up any more");
  });

  it("sets up a wildcard domain, waits until the app answers on its base, then turns workers.dev off", async () => {
    const saas = fakeSaas();
    const r = await run(
      { kind: "wildcard", zoneId: "z-own", hostname: "tunnels.own.example" },
      saas,
    );
    expect(r.step.names).toEqual([
      "add wildcard domain tunnels.own.example",
      "wait for tunnels.own.example",
      "tunnels.own.example is live",
    ]);
    expect(r.self.calls.map((c) => c.unit)).toEqual(["attachDomain", "waitForCustomDomain"]);
    expect(r.probes).toEqual(["https://tunnels.own.example/"]);
    expect(saas.world.records.map((rec) => [rec.type, rec.name, rec.content, rec.proxied])).toEqual(
      [
        ["AAAA", "tunnels.own.example", "100::", true],
        ["AAAA", "*.tunnels.own.example", "100::", true],
      ],
    );
    expect(saas.world.routes.map((route) => [route.pattern, route.script])).toEqual([
      ["tunnels.own.example/*", "cut"],
      ["*.tunnels.own.example/*", "cut"],
    ]);
    const recorded = (
      await env.DB.prepare(
        "SELECT kind, binding, name FROM resources WHERE install_id = ?1 AND kind IN ('wildcard_domain', 'dns_record', 'worker_route') ORDER BY rowid",
      )
        .bind(INSTALL_ID)
        .all()
    ).results;
    expect(recorded).toEqual([
      { kind: "wildcard_domain", binding: null, name: "tunnels.own.example" },
      { kind: "dns_record", binding: "tunnels.own.example", name: "tunnels.own.example" },
      { kind: "dns_record", binding: "tunnels.own.example", name: "*.tunnels.own.example" },
      { kind: "worker_route", binding: "tunnels.own.example", name: "tunnels.own.example/*" },
      { kind: "worker_route", binding: "tunnels.own.example", name: "*.tunnels.own.example/*" },
    ]);
    expect(r.subdomainCalls).toEqual([{ enabled: false, previews_enabled: true }]);
    expect(await installRow()).toMatchObject({ served_domain: "tunnels.own.example" });
    expect(await liveDomains()).toEqual(["tunnels.own.example"]);
    expect(r.servedBy).toBe("tunnels.own.example");
  });

  it("leaves a wildcard name that has DNS records of its own, and finishes the install", async () => {
    const saas = fakeSaas({
      records: [
        {
          id: "rec-site",
          zone: "z-own",
          type: "A",
          name: "tunnels.own.example",
          content: "192.0.2.1",
          proxied: true,
        },
      ],
    });
    const r = await run(
      { kind: "wildcard", zoneId: "z-own", hostname: "tunnels.own.example" },
      saas,
    );
    expect(r.step.names).toEqual(["add wildcard domain tunnels.own.example"]);
    expect(saas.world.routes).toEqual([]);
    expect(saas.world.records.map((rec) => rec.id)).toEqual(["rec-site"]);
    expect(r.logs.at(-1)).toMatchObject({ level: "warn" });
    expect(r.logs.at(-1)?.message).toContain(
      "*.tunnels.own.example could not be set up: tunnels.own.example already has DNS records (A 192.0.2.1)",
    );
    expect(r.servedBy).toBeNull();
  });

  it("leaves a base whose names already serve something, and says which", async () => {
    const saas = fakeSaas({
      records: [
        {
          id: "rec-api",
          zone: "z-own",
          type: "CNAME",
          name: "api.tunnels.own.example",
          content: "backend.example.net",
          proxied: true,
        },
      ],
    });
    const r = await run(
      { kind: "wildcard", zoneId: "z-own", hostname: "tunnels.own.example" },
      saas,
    );
    expect(r.step.names).toEqual(["add wildcard domain tunnels.own.example"]);
    expect(saas.world.routes).toEqual([]);
    expect(saas.world.records.map((rec) => rec.id)).toEqual(["rec-api"]);
    expect(r.logs.at(-1)?.message).toContain(
      "*.tunnels.own.example could not be set up: api.tunnels.own.example already serves something through Cloudflare",
    );
  });
});
