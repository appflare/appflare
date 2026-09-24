import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { setUpGatewayCore } from "../../gateway/gateway.server";
import type { InstallDomainInput } from "../../installs/install-input";
import { ACC, TOKEN } from "../../test/fake-account";
import { fakeSaas, GATEWAY_ZONE } from "../../test/fake-saas";
import { fakeSelf } from "../../test/fake-self";
import { fakeStep } from "../../test/fake-step";
import { INSTALL_ID, seedInstall } from "../../test/seed-install";
import { createJobSteps } from "../steps";
import { EXTERNAL_DOMAIN_MAX_POLLS } from "../units/domains";
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

async function run(domain: InstallDomainInput, saas: ReturnType<typeof fakeSaas>) {
  const probes: string[] = [];
  // The app answers on its external domain; everything else is the SaaS fake.
  const fetch: FetchLike = async (input, init) => {
    if (input.startsWith("https://api.cloudflare.com/")) return saas.fetch(input, init);
    probes.push(input);
    return new Response("<html>cut</html>");
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
  await installDomainPhase(steps, {
    db: env.DB,
    installId: INSTALL_ID,
    workerName: "cut",
    domain,
    health: { path: "/", mode: "default" },
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
  return { step, self, logs, rows, probes };
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
    ]);
    expect(r.self.calls.map((c) => c.unit)).toEqual(["attachDomain", "waitForExternalDomain"]);
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
});
