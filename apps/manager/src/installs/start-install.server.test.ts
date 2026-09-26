import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { readAccountPlan, writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import type { InstallJobParams } from "../jobs/install";
import { type ArtifactFixture, buildArtifactFixture } from "../test/artifact-fixture";
import type { StartInstallInput } from "./install-input";
import { resolveInstallInput, StartInstallError, startInstallCore } from "./start-install.server";

const NOW = new Date("2026-09-22T12:00:00.000Z");

function harness(fixture: ArtifactFixture, createJob?: (id: string) => Promise<{ id: string }>) {
  const created: Array<{ id: string; params: InstallJobParams }> = [];
  let n = 0;
  return {
    created,
    deps: {
      db: env.DB,
      loadApp: async (slug: string) => {
        if (slug !== "cut") throw new StartInstallError(`"${slug}" is not in the catalog.`);
        return { app: fixture.index, manifest: fixture.manifest };
      },
      createJob: async (id: string, params: InstallJobParams) => {
        created.push({ id, params });
        return createJob ? createJob(id) : { id };
      },
      now: () => NOW,
      newId: () => `id${++n}`,
    },
  };
}

const input = (over: Partial<StartInstallInput> = {}): StartInstallInput => ({
  slug: "cut",
  workerName: "cut",
  secrets: { ADMIN_PASSWORD: "hunter2-hunter2" },
  vars: { HOME_PAGE: "admin" },
  paidConfirmed: false,
  requirementsConfirmed: false,
  ...over,
});

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("startInstallCore", () => {
  it("records the install and the job, and passes secret values only to the Workflow", async () => {
    const f = await buildArtifactFixture();
    const h = harness(f);
    expect(await startInstallCore(h.deps, input())).toEqual({ installId: "id1", jobId: "id2" });

    const install = await env.DB.prepare("SELECT * FROM installs WHERE id = 'id1'").first();
    expect(install).toMatchObject({
      app_slug: "cut",
      worker_name: "cut",
      // No display name: the Worker name is shown.
      display_name: null,
      instance_name: "cut",
      status: "installing",
      catalog_version: "1.0.0",
      artifact_url: f.index.artifacts.zip,
      artifact_digest: f.digest,
      config_json: JSON.stringify({ HOME_PAGE: "admin" }),
      installed_at: NOW.getTime(),
    });
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = 'id2'").first<{
      input_json: string;
    }>();
    expect(job).toMatchObject({
      install_id: "id1",
      kind: "install",
      status: "queued",
      workflow_instance_id: "id2",
    });
    expect(job?.input_json).not.toContain("hunter2");
    expect(JSON.parse(job?.input_json ?? "{}").secrets).toEqual(["ADMIN_PASSWORD"]);

    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.params).toMatchObject({
      kind: "install",
      jobId: "id2",
      installId: "id1",
      workerName: "cut",
      digest: f.digest,
      secrets: { ADMIN_PASSWORD: "hunter2-hunter2" },
    });
  });

  it("refuses a Worker name another install already uses", async () => {
    const f = await buildArtifactFixture();
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('old', 'other-app', 'cut', '1', 'u', 'installed', 1, 1)`,
    ).run();
    const h = harness(f);
    await expect(startInstallCore(h.deps, input())).rejects.toThrow(
      'Another install already uses the Worker name "cut".',
    );
    expect(h.created).toHaveLength(0);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("installs a second instance of an app under another Worker name, with its own display name", async () => {
    const f = await buildArtifactFixture();
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('old', 'cut', 'cut', 'cut', '1', 'u', 'installed', 1, 1)`,
    ).run();
    const h = harness(f);
    await expect(
      startInstallCore(h.deps, input({ workerName: "cut-2", displayName: "Team links" })),
    ).resolves.toEqual({ installId: "id1", jobId: "id2" });
    const rows = await env.DB.prepare(
      "SELECT id, worker_name, display_name, instance_name, status FROM installs ORDER BY id",
    ).all();
    expect(rows.results).toEqual([
      {
        id: "id1",
        worker_name: "cut-2",
        display_name: "Team links",
        instance_name: "Team links",
        status: "installing",
      },
      {
        id: "old",
        worker_name: "cut",
        display_name: null,
        instance_name: "cut",
        status: "installed",
      },
    ]);
    // The name stays out of the job's record and the Workflow's params.
    const job = await env.DB.prepare("SELECT input_json FROM jobs WHERE id = 'id2'").first<{
      input_json: string;
    }>();
    expect(job?.input_json).not.toContain("Team links");
    expect(JSON.stringify(h.created[0]?.params)).not.toContain("Team links");
  });

  it("refuses the same Worker name while any install that is not uninstalled holds it", async () => {
    const f = await buildArtifactFixture();
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('old', 'cut', 'cut', '1', 'u', 'installed', 1, 1)`,
    ).run();
    for (const status of ["installing", "installed", "updating", "uninstalling"]) {
      await env.DB.prepare("UPDATE installs SET status = ?1 WHERE id = 'old'").bind(status).run();
      await expect(startInstallCore(harness(f).deps, input())).rejects.toThrow(
        'Another install already uses the Worker name "cut".',
      );
    }
    await env.DB.prepare("UPDATE installs SET status = 'uninstalled' WHERE id = 'old'").run();
    await expect(startInstallCore(harness(f).deps, input())).resolves.toMatchObject({
      installId: "id1",
    });
  });

  it("installs an app with a fixed Worker name once, and only under that name", async () => {
    const f = await buildArtifactFixture({
      catalog: {
        install: {
          tier: "artifact",
          packageManager: "pnpm",
          wranglerConfig: "wrangler.jsonc",
          workerName: "cut",
          fixedWorkerName: true,
        },
      },
    });
    await expect(startInstallCore(harness(f).deps, input({ workerName: "cut-2" }))).rejects.toThrow(
      'Cut only works as the Worker "cut"; its Worker name cannot be changed.',
    );
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('old', 'cut', 'somewhere-else', '1', 'u', 'installed', 1, 1)`,
    ).run();
    await expect(startInstallCore(harness(f).deps, input())).rejects.toThrow(
      'Cut is already installed as "somewhere-else". It only works under one Worker name, so it installs once per account.',
    );
    await env.DB.prepare("UPDATE installs SET status = 'uninstalled' WHERE id = 'old'").run();
    await expect(startInstallCore(harness(f).deps, input())).resolves.toMatchObject({
      installId: "id1",
    });
  });

  it("refuses a Worker name that already exists in the account, and tolerates a failed listing", async () => {
    const f = await buildArtifactFixture();
    const h = harness(f);
    await expect(
      startInstallCore({ ...h.deps, listAccountWorkers: async () => ["appflare", "cut"] }, input()),
    ).rejects.toThrow(/A Worker named "cut" already exists in this account/);
    expect(h.created).toHaveLength(0);
    await expect(
      startInstallCore(
        {
          ...h.deps,
          listAccountWorkers: async () => {
            throw new Error("API unavailable");
          },
        },
        input(),
      ),
    ).resolves.toMatchObject({ installId: "id1" });
  });

  it("lets a failed install that still owns resources block only its own Worker name", async () => {
    const f = await buildArtifactFixture();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at)
         VALUES ('old', 'cut', 'cut', '1', 'u', 'failed', 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES ('r1', 'old', 'kv', 'CUT_KV', 'cut-cut-kv', 'kv1', 1)`,
      ),
    ]);
    await expect(
      startInstallCore(harness(f).deps, input({ workerName: "cut-2" })),
    ).resolves.toMatchObject({
      installId: "id1",
    });
    const old = await env.DB.prepare("SELECT status FROM installs WHERE id = 'old'").first();
    expect(old).toEqual({ status: "failed" });
  });

  it("retires a failed install that holds no resources, so the app can be retried", async () => {
    const f = await buildArtifactFixture();
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('old', 'cut', 'cut', '1', 'u', 'failed', 1, 1)`,
    ).run();
    await expect(startInstallCore(harness(f).deps, input())).resolves.toMatchObject({
      installId: "id1",
    });
    const old = await env.DB.prepare(
      "SELECT status, uninstalled_at FROM installs WHERE id = 'old'",
    ).first();
    expect(old).toEqual({ status: "uninstalled", uninstalled_at: NOW.getTime() });
  });

  it("keeps blocking on a failed install that still owns resources", async () => {
    const f = await buildArtifactFixture();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at)
         VALUES ('old', 'cut', 'cut', '1', 'u', 'failed', 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES ('r1', 'old', 'kv', 'CUT_KV', 'cut-cut-kv', 'kv1', 1)`,
      ),
    ]);
    const h = harness(f);
    await expect(startInstallCore(h.deps, input())).rejects.toThrow(
      /failed install of the Worker "cut" still owns resources in this account\. Uninstall it first\./,
    );
    expect(h.created).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("requires every secret, including generate:true ones", async () => {
    const f = await buildArtifactFixture({
      catalog: {
        secrets: [
          { name: "ADMIN_PASSWORD", label: "Admin password", generate: true },
          { name: "API_KEY", label: "API key", generate: false },
        ],
      },
    });
    expect(() => resolveInstallInput(f.manifest, input({ secrets: { API_KEY: "k" } }))).toThrow(
      "Admin password (ADMIN_PASSWORD) is required.",
    );
    expect(() =>
      resolveInstallInput(f.manifest, input({ secrets: { ADMIN_PASSWORD: "x".repeat(32) } })),
    ).toThrow("API key (API_KEY) is required.");
    const resolved = resolveInstallInput(
      f.manifest,
      input({ secrets: { ADMIN_PASSWORD: "p", API_KEY: "k" } }),
    );
    expect(resolved.secrets).toEqual({ ADMIN_PASSWORD: "p", API_KEY: "k" });
  });

  it("computes a derived secret from its source and never takes it from the form", async () => {
    const f = await buildArtifactFixture({
      catalog: {
        secrets: [
          { name: "CF_PASSWORD", label: "Admin password", generate: false },
          {
            name: "CF_PASSWORD_HASH",
            label: "Admin password hash",
            generate: false,
            derive: { from: "CF_PASSWORD", method: "bcrypt" },
          },
        ],
      },
    });
    expect(() =>
      resolveInstallInput(
        f.manifest,
        input({ secrets: { CF_PASSWORD: "pw", CF_PASSWORD_HASH: "$2b$10$forged" } }),
      ),
    ).toThrow("does not take: CF_PASSWORD_HASH");

    const h = harness(f);
    await startInstallCore(h.deps, input({ secrets: { CF_PASSWORD: "correct horse" } }));
    const secrets = h.created[0]?.params.secrets ?? {};
    expect(Object.keys(secrets).sort()).toEqual(["CF_PASSWORD", "CF_PASSWORD_HASH"]);
    expect(secrets.CF_PASSWORD_HASH).toMatch(/^\$2b\$10\$/);
    expect(bcrypt.compareSync("correct horse", secrets.CF_PASSWORD_HASH ?? "")).toBe(true);
    const job = await env.DB.prepare("SELECT input_json FROM jobs").first<{ input_json: string }>();
    // Names only: neither value is stored outside the Workflow params.
    expect(JSON.parse(job?.input_json ?? "{}").secrets).toEqual([
      "CF_PASSWORD",
      "CF_PASSWORD_HASH",
    ]);
    expect(job?.input_json).not.toContain("correct horse");
    expect(job?.input_json).not.toContain("$2b$");
  });

  it("leaves an optional secret unset when it has no value", async () => {
    const f = await buildArtifactFixture({
      catalog: {
        secrets: [
          { name: "API_KEY", label: "API key", generate: false },
          { name: "SMTP_PASSWORD", label: "SMTP password", generate: false, optional: true },
        ],
      },
    });
    expect(
      resolveInstallInput(f.manifest, input({ secrets: { API_KEY: "k", SMTP_PASSWORD: "" } }))
        .secrets,
    ).toEqual({ API_KEY: "k" });
    expect(
      resolveInstallInput(f.manifest, input({ secrets: { API_KEY: "k", SMTP_PASSWORD: "s" } }))
        .secrets,
    ).toEqual({ API_KEY: "k", SMTP_PASSWORD: "s" });
    expect(() =>
      resolveInstallInput(f.manifest, input({ secrets: { SMTP_PASSWORD: "s" } })),
    ).toThrow("API key (API_KEY) is required.");
  });

  it("takes only one of a select var's choices", async () => {
    const f = await buildArtifactFixture({
      catalog: {
        vars: [
          {
            name: "HOME_PAGE",
            label: "Home page",
            required: false,
            type: "select",
            options: [
              { value: "default", label: "Landing page" },
              { value: "404", label: "Not found" },
            ],
          },
        ],
      },
    });
    expect(resolveInstallInput(f.manifest, input({ vars: { HOME_PAGE: "404" } })).vars).toEqual({
      HOME_PAGE: "404",
    });
    expect(() => resolveInstallInput(f.manifest, input({ vars: { HOME_PAGE: "admin" } }))).toThrow(
      "Home page (HOME_PAGE) must be one of: Landing page, Not found.",
    );
  });

  it("rejects undeclared names and enforces required vars and the paid confirmation", async () => {
    const f = await buildArtifactFixture({
      catalog: {
        plan: "paid",
        vars: [{ name: "REGION", label: "Region", required: true }],
      },
    });
    expect(() => resolveInstallInput(f.manifest, input({ vars: { REGION: "eu" } }))).toThrow(
      /needs Workers Paid/,
    );
    expect(() => resolveInstallInput(f.manifest, input({ paidConfirmed: true, vars: {} }))).toThrow(
      "Region (REGION) is required.",
    );
    expect(() =>
      resolveInstallInput(
        f.manifest,
        input({ paidConfirmed: true, vars: { REGION: "eu", EXTRA: "x" }, secrets: { X: "y" } }),
      ),
    ).toThrow("Cut does not take: X, EXTRA.");
    const ok = resolveInstallInput(
      f.manifest,
      input({ paidConfirmed: true, vars: { REGION: " eu " } }),
    );
    expect(ok.vars).toEqual({ REGION: "eu" });
  });

  it("takes JSON for a JSON var and lets the wrangler config's value satisfy a required var", async () => {
    const f = await buildArtifactFixture({
      bindings: [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "json", name: "ADDRESSES", json: [] },
        { type: "plain_text", name: "REGION", text: "eu" },
      ],
      catalog: {
        vars: [
          { name: "ADDRESSES", label: "Addresses", required: true },
          { name: "REGION", label: "Region", required: true },
        ],
      },
    });
    expect(() =>
      resolveInstallInput(f.manifest, input({ vars: { ADDRESSES: "inbox@example.com" } })),
    ).toThrow(/^Addresses \(ADDRESSES\) is not valid JSON/);
    // Placeholders are kept as entered; the jobs fill them in.
    const ok = resolveInstallInput(
      f.manifest,
      input({ vars: { ADDRESSES: ' ["{{workerName}}@example.com"] ' } }),
    );
    expect(ok.vars).toEqual({ ADDRESSES: '["{{workerName}}@example.com"]' });
    expect(resolveInstallInput(f.manifest, input({ vars: {} })).vars).toEqual({});
  });

  it("refuses an app with account requirements until they are confirmed", async () => {
    const f = await buildArtifactFixture({ catalog: { requires: ["r2", "zone"] } });
    expect(() => resolveInstallInput(f.manifest, input())).toThrow(
      "Cut needs: R2, A zone on this account. Confirm that this account meets these requirements.",
    );
    expect(() =>
      resolveInstallInput(f.manifest, input({ requirementsConfirmed: true })),
    ).not.toThrow();

    const h = harness(f);
    await expect(startInstallCore(h.deps, input())).rejects.toBeInstanceOf(StartInstallError);
    expect(h.created).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>();
    expect(rows?.n).toBe(0);

    await startInstallCore(h.deps, input({ requirementsConfirmed: true }));
    expect(h.created[0]?.params.requirementsConfirmed).toBe(true);
    const job = await env.DB.prepare("SELECT input_json FROM jobs").first<{ input_json: string }>();
    expect(JSON.parse(job?.input_json ?? "{}").requirementsConfirmed).toBe(true);
  });

  it("does not ask for the confirmation when the app has no account requirements", async () => {
    const f = await buildArtifactFixture();
    expect(() => resolveInstallInput(f.manifest, input())).not.toThrow();
  });

  describe("the account's Workers plan", () => {
    const paidApp = { catalog: { plan: "paid" as const } };

    it("takes Workers Paid as confirmed when Settings records it", async () => {
      await writeAccountPlan(createDb(env.DB), "paid");
      const h = harness(await buildArtifactFixture(paidApp));
      await startInstallCore(h.deps, input({ paidConfirmed: false }));
      expect(h.created[0]?.params.paidConfirmed).toBe(true);
    });

    it("still asks per install while Settings says free", async () => {
      const h = harness(await buildArtifactFixture(paidApp));
      await expect(startInstallCore(h.deps, input({ paidConfirmed: false }))).rejects.toThrow(
        /needs Workers Paid\. Confirm that this account is on Workers Paid\./,
      );
      expect(await readAccountPlan(createDb(env.DB))).toBe("free");
    });

    it("records Workers Paid for the account when asked to remember a ticked confirmation", async () => {
      const h = harness(await buildArtifactFixture(paidApp));
      await startInstallCore(h.deps, input({ paidConfirmed: true, rememberPaidPlan: true }));
      expect(await readAccountPlan(createDb(env.DB))).toBe("paid");
    });

    it("leaves the plan unchanged when the start is refused", async () => {
      const h = harness(await buildArtifactFixture(paidApp));
      await startInstallCore(h.deps, input({ paidConfirmed: true }));
      // The Worker name is taken now, so this start is refused after its form checks.
      await expect(
        startInstallCore(h.deps, input({ paidConfirmed: true, rememberPaidPlan: true })),
      ).rejects.toThrow(/Another install already uses the Worker name "cut"/);
      expect(await readAccountPlan(createDb(env.DB))).toBe("free");

      const existing = harness(await buildArtifactFixture(paidApp));
      await expect(
        startInstallCore(
          { ...existing.deps, listAccountWorkers: async () => ["cut-2"] },
          input({ workerName: "cut-2", paidConfirmed: true, rememberPaidPlan: true }),
        ),
      ).rejects.toThrow(/A Worker named "cut-2" already exists/);
      expect(await readAccountPlan(createDb(env.DB))).toBe("free");
    });

    it("does not record the plan without a ticked confirmation", async () => {
      const h = harness(await buildArtifactFixture());
      await startInstallCore(h.deps, input({ paidConfirmed: false, rememberPaidPlan: true }));
      expect(await readAccountPlan(createDb(env.DB))).toBe("free");
      expect(h.created[0]?.params.paidConfirmed).toBe(false);
    });
  });

  describe("an address besides workers.dev", () => {
    it("passes a custom domain to the job, lower-cased", async () => {
      const f = await buildArtifactFixture();
      const h = harness(f);
      await startInstallCore(
        h.deps,
        input({ domain: { kind: "custom", zoneId: "z1", hostname: " Cut.Example.com. " } }),
      );
      expect(h.created[0]?.params.domain).toEqual({
        kind: "custom",
        zoneId: "z1",
        hostname: "cut.example.com",
      });
      const job = await env.DB.prepare("SELECT input_json FROM jobs WHERE id = 'id2'").first<{
        input_json: string;
      }>();
      expect(JSON.parse(job?.input_json ?? "{}").domain).toEqual({
        kind: "custom",
        zoneId: "z1",
        hostname: "cut.example.com",
      });
    });

    it("passes a zone's root on as the custom domain", async () => {
      const f = await buildArtifactFixture();
      const h = harness(f);
      // What the install form sends for an empty subdomain in example.com.
      await startInstallCore(
        h.deps,
        input({ domain: { kind: "custom", zoneId: "z1", hostname: "example.com" } }),
      );
      expect(h.created[0]?.params.domain).toEqual({
        kind: "custom",
        zoneId: "z1",
        hostname: "example.com",
      });
    });

    it("refuses an external domain until the gateway is set up, then passes it on", async () => {
      const f = await buildArtifactFixture();
      const h = harness(f);
      const external = input({
        domain: { kind: "external", hostname: "Go.Customer.test", validation: "txt" },
      });
      await expect(startInstallCore(h.deps, external)).rejects.toThrow(
        "External domains need the gateway",
      );
      expect(h.created).toEqual([]);
      await writeSettings(createDb(env.DB), {
        [SETTING.externalDomainsGateway]: JSON.stringify({
          zoneId: "z-gw",
          zoneName: "gateway.example",
          kvId: "kv-1",
          readyAt: NOW.toISOString(),
        }),
      });
      await startInstallCore(h.deps, external);
      expect(h.created[0]?.params.domain).toEqual({
        kind: "external",
        hostname: "go.customer.test",
        validation: "txt",
      });
    });

    it("refuses a hostname another app already has, in any spelling", async () => {
      const f = await buildArtifactFixture();
      const h = harness(f);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
             artifact_url, status, installed_at, updated_at)
           VALUES ('other', 'blog', 'blog', 'blog', '1.0.0', 'u', 'installed', 1, 1)`,
        ),
        env.DB.prepare(
          `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
           VALUES ('d1', 'other', 'domain', NULL, 'xn--bcher-kva.example.com', 'cfd', 1)`,
        ),
      ]);
      await expect(
        startInstallCore(
          h.deps,
          input({ domain: { kind: "custom", zoneId: "z1", hostname: "Bücher.example.com" } }),
        ),
      ).rejects.toThrow("already a domain of another app");
      expect(h.created).toEqual([]);
    });

    it("refuses a hostname that is not one", async () => {
      const f = await buildArtifactFixture();
      const h = harness(f);
      await expect(
        startInstallCore(
          h.deps,
          input({ domain: { kind: "external", hostname: "*.customer.test", validation: "http" } }),
        ),
      ).rejects.toThrow("wildcards");
    });
  });

  it("marks the job and install failed when the Workflow instance cannot be created", async () => {
    const f = await buildArtifactFixture();
    const h = harness(f, async () => {
      throw new Error("binding unavailable");
    });
    await expect(startInstallCore(h.deps, input())).rejects.toThrow(/could not create the job/);
    const job = await env.DB.prepare("SELECT status, error FROM jobs").first();
    expect(job).toEqual({
      status: "failed",
      error: "start: could not create the job: binding unavailable",
    });
    const install = await env.DB.prepare("SELECT status FROM installs").first();
    expect(install).toEqual({ status: "failed" });
  });
});

describe("startInstallCore while Appflare updates itself", () => {
  it("refuses with the self-update's job id, settling a dead one first", async () => {
    const f = await buildArtifactFixture();
    await env.DB.prepare(
      "INSERT INTO jobs (id, kind, status, workflow_instance_id) VALUES ('self', 'self_update', 'running', 'self')",
    ).run();
    const running = { get: async () => ({ status: async () => ({ status: "running" }) }) };
    await expect(
      startInstallCore({ ...harness(f).deps, workflows: running }, input()),
    ).rejects.toThrow(/Appflare is updating itself \(job self\).*\/jobs\/self/);

    const dead = { get: async () => ({ status: async () => ({ status: "terminated" }) }) };
    expect(await startInstallCore({ ...harness(f).deps, workflows: dead }, input())).toEqual({
      installId: "id1",
      jobId: "id2",
    });
  });

  it("loses the claim atomically to a self-update that starts after its check", async () => {
    const f = await buildArtifactFixture();
    const h = harness(f);
    await expect(
      startInstallCore(
        {
          ...h.deps,
          // Runs after the self-update check and before the claim batch.
          listAccountWorkers: async () => {
            await env.DB.prepare(
              "INSERT INTO jobs (id, kind, status) VALUES ('late', 'self_update', 'queued')",
            ).run();
            return [];
          },
        },
        input(),
      ),
    ).rejects.toThrow(/Appflare is updating itself \(job late\)/);
    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM installs) AS installs, (SELECT COUNT(*) FROM jobs) AS jobs",
    ).first();
    expect(counts).toEqual({ installs: 0, jobs: 1 });
    expect(h.created).toEqual([]);
  });
});
