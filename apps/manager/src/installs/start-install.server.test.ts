import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { generateVapidPrivateKey, vapidPublicKey } from "@appflare/schema";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { INSTALL_ACCESS_MESSAGES } from "../access/messages";
import { readAccountPlan, writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import type { InstallJobParams } from "../jobs/install";
import type { UninstallJobParams } from "../jobs/uninstall";
import { type ArtifactFixture, buildArtifactFixture } from "../test/artifact-fixture";
import type { StartInstallInput } from "./install-input";
import { resolveInstallInput, StartInstallError, startInstallCore } from "./start-install.server";

const NOW = new Date("2026-09-22T12:00:00.000Z");

function harness(fixture: ArtifactFixture, createJob?: (id: string) => Promise<{ id: string }>) {
  const created: Array<{ id: string; params: InstallJobParams }> = [];
  /** Every Workflow instance created, the removal of a replaced install's leftovers included. */
  const all: Array<{ id: string; params: InstallJobParams | UninstallJobParams }> = [];
  let n = 0;
  return {
    created,
    all,
    deps: {
      db: env.DB,
      loadApp: async (slug: string) => {
        if (slug !== "cut") throw new StartInstallError(`"${slug}" is not in the catalog.`);
        return { app: fixture.index, manifest: fixture.manifest };
      },
      createJob: async (id: string, params: InstallJobParams | UninstallJobParams) => {
        all.push({ id, params });
        if (params.kind === "install") created.push({ id, params });
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
    // Not asked for: not protected.
    expect(h.created[0]?.params.access).toBeUndefined();
  });

  it("passes Cloudflare Access protection to the job and records it with the job's input", async () => {
    const f = await buildArtifactFixture();
    const h = harness(f);
    await startInstallCore(h.deps, input({ access: true }));
    expect(h.created[0]?.params.access).toBe(true);
    const job = await env.DB.prepare("SELECT input_json FROM jobs WHERE id = 'id2'").first<{
      input_json: string;
    }>();
    expect(JSON.parse(job?.input_json ?? "{}").access).toBe(true);
  });

  it("checks the account can provide Cloudflare Access for an app that will be protected, before anything is recorded", async () => {
    const checked: string[] = [];
    const refusingPreflight = async () => {
      checked.push("asked");
      return {
        message: "This Cloudflare account has no Zero Trust organization yet.",
        unchecked: false,
      };
    };
    const refusal =
      "Cut needs Cloudflare Access, which this account cannot provide yet: This Cloudflare account has no Zero Trust organization yet.";
    // Protection required by the entry: always checked.
    const required = harness(
      await buildArtifactFixture({
        catalog: { requires: ["access"], access: { mode: "required" } },
      }),
    );
    await expect(
      startInstallCore(
        { ...required.deps, accessPreflight: refusingPreflight },
        input({ requirementsConfirmed: true }),
      ),
    ).rejects.toThrow(refusal);
    expect(checked).toEqual(["asked"]);
    expect(required.created).toEqual([]);
    expect(await env.DB.prepare("SELECT id FROM installs").first()).toBeNull();
    // Protection turned on by the admin: checked too.
    const ticked = harness(await buildArtifactFixture({ catalog: { requires: ["access"] } }));
    await expect(
      startInstallCore(
        { ...ticked.deps, accessPreflight: refusingPreflight },
        input({ access: true }),
      ),
    ).rejects.toThrow(refusal);
    expect(checked).toEqual(["asked", "asked"]);
    expect(ticked.created).toEqual([]);
  });

  it("refuses with only that Cloudflare could not be asked, when the check got no answer", async () => {
    const h = harness(await buildArtifactFixture({ catalog: { requires: ["access"] } }));
    const unchecked = INSTALL_ACCESS_MESSAGES.unchecked("HTTP 500");
    const refused = await startInstallCore(
      { ...h.deps, accessPreflight: async () => ({ message: unchecked, unchecked: true }) },
      input({ access: true }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    // Not "needs Cloudflare Access, which this account cannot provide": nothing is known to be missing.
    expect(refused).toBeInstanceOf(StartInstallError);
    expect((refused as Error).message).toBe(unchecked);
    expect(h.created).toEqual([]);
  });

  it('installs an entry that lists "access" without requiring it unprotected, on any account, with nothing to confirm', async () => {
    // The requirement holds only while the app is protected: the admin left
    // protection off, so the account's Zero Trust is never asked about.
    const f = await buildArtifactFixture({ catalog: { requires: ["access"] } });
    const h = harness(f);
    await startInstallCore(
      { ...h.deps, accessPreflight: async () => ({ message: "never asked", unchecked: false }) },
      input(),
    );
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.params).not.toHaveProperty("access");
    // An app that needs nothing of Access is not checked either.
    const plain = harness(await buildArtifactFixture());
    await startInstallCore(
      {
        ...plain.deps,
        newId: (() => {
          let n = 10;
          return () => `id${++n}`;
        })(),
        accessPreflight: async () => ({ message: "never asked", unchecked: false }),
      },
      input({ workerName: "cut-2" }),
    );
    expect(plain.created).toHaveLength(1);
    // Another requirement still asks for the confirmation.
    const r2 = await buildArtifactFixture({ catalog: { requires: ["access", "r2"] } });
    expect(() => resolveInstallInput(r2.manifest, input())).toThrow(
      "Cut needs: R2. Confirm that this account meets these requirements.",
    );
  });

  it("takes Cloudflare Access protection together with an external domain", async () => {
    const f = await buildArtifactFixture();
    expect(
      resolveInstallInput(
        f.manifest,
        input({
          access: true,
          domain: { kind: "external", hostname: "go.customer.net", validation: "http" },
        }),
      ),
    ).toMatchObject({
      access: true,
      domain: { kind: "external", hostname: "go.customer.net" },
    });
  });

  it("records the catalog an app comes from, and passes it to the job", async () => {
    const f = await buildArtifactFixture();
    const h = harness(f);
    const deps = {
      ...h.deps,
      loadApp: async (key: string) => {
        expect(key).toBe("acme:cut");
        return { app: f.index, catalogId: "acme", manifest: f.manifest };
      },
    };
    await startInstallCore(deps, input({ slug: "acme:cut" }));
    const install = await env.DB.prepare(
      "SELECT app_slug, catalog_id FROM installs WHERE id = 'id1'",
    ).first();
    // The plain slug, as the signed artifact names it, with its catalog beside it.
    expect(install).toEqual({ app_slug: "cut", catalog_id: "acme" });
    expect(h.created[0]?.params).toMatchObject({ slug: "cut", catalogId: "acme" });

    // The official catalog's installs record it too, and their jobs carry no catalog id.
    await startInstallCore(h.deps, input({ workerName: "cut-2" }));
    const official = await env.DB.prepare(
      "SELECT app_slug, catalog_id FROM installs WHERE id = 'id3'",
    ).first();
    expect(official).toEqual({ app_slug: "cut", catalog_id: "official" });
    expect(h.created.at(-1)?.params).not.toHaveProperty("catalogId");
  });

  it("refuses an added catalog's sandbox or self-deploying entry", async () => {
    const f = await buildArtifactFixture();
    const h = harness(f);
    const { artifacts: _a, ...rest } = f.index;
    const build = {
      pin: "6056400d47530aa87e4ae5764b37ffca9d00e87f",
      manifest: "https://acme.test/apps/cut.json",
      manifestDigest: "a".repeat(64),
    };
    for (const tier of ["sandbox", "self-deploying"] as const) {
      const deps = {
        ...h.deps,
        loadApp: async () => ({
          app: { ...rest, tier, build },
          catalogId: "acme",
          manifest: f.manifest,
        }),
      };
      await expect(startInstallCore(deps, input({ slug: "acme:cut" }))).rejects.toThrow(
        "This catalog's index is not signed; only prebuilt releases are installed from added catalogs.",
      );
    }
    expect(h.created).toEqual([]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>();
    expect(count?.n).toBe(0);
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
          { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
          { name: "API_KEY", label: "API key" },
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
          { name: "CF_PASSWORD", label: "Admin password" },
          {
            name: "CF_PASSWORD_HASH",
            label: "Admin password hash",
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

  it("stores a VAPID public key var derived from the private key secret", async () => {
    const f = await buildArtifactFixture({
      catalog: {
        secrets: [
          { name: "VAPID_PRIVATE_KEY", label: "Push signing key", generate: "vapid-private-key" },
        ],
        vars: [
          {
            name: "VAPID_PUBLIC_KEY",
            label: "Push public key",
            derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
          },
        ],
      },
    });
    const privateKey = generateVapidPrivateKey();
    // The form never sends a derived var, and a private key must be one.
    expect(() =>
      resolveInstallInput(
        f.manifest,
        input({
          secrets: { VAPID_PRIVATE_KEY: privateKey },
          vars: { VAPID_PUBLIC_KEY: "forged" },
        }),
      ),
    ).toThrow("VAPID_PUBLIC_KEY is computed from VAPID_PRIVATE_KEY");
    expect(() =>
      resolveInstallInput(
        f.manifest,
        input({ secrets: { VAPID_PRIVATE_KEY: "not-a-key" }, vars: {} }),
      ),
    ).toThrow("Push signing key (VAPID_PRIVATE_KEY) must be a VAPID private key");

    const h = harness(f);
    await startInstallCore(h.deps, input({ secrets: { VAPID_PRIVATE_KEY: privateKey }, vars: {} }));
    const params = h.created[0]?.params;
    expect(params?.secrets).toEqual({ VAPID_PRIVATE_KEY: privateKey });
    expect(params?.vars).toEqual({ VAPID_PUBLIC_KEY: await vapidPublicKey(privateKey) });
    const install = await env.DB.prepare("SELECT config_json FROM installs").first<{
      config_json: string;
    }>();
    expect(JSON.parse(install?.config_json ?? "{}")).toEqual({
      VAPID_PUBLIC_KEY: await vapidPublicKey(privateKey),
    });
    expect(install?.config_json).not.toContain(privateKey);
  });

  it("leaves an optional secret unset when it has no value", async () => {
    const f = await buildArtifactFixture({
      catalog: {
        secrets: [
          { name: "API_KEY", label: "API key" },
          { name: "SMTP_PASSWORD", label: "SMTP password", optional: true },
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
            optional: true,
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
      "Home page must be one of: Landing page, Not found.",
    );
  });

  it("rejects undeclared names and enforces required vars and the paid confirmation", async () => {
    const f = await buildArtifactFixture({
      catalog: {
        plan: "paid",
        vars: [{ name: "REGION", label: "Region" }],
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
          { name: "ADDRESSES", label: "Addresses" },
          { name: "REGION", label: "Region" },
        ],
      },
    });
    expect(() =>
      resolveInstallInput(f.manifest, input({ vars: { ADDRESSES: "inbox@example.com" } })),
    ).toThrow(/^Addresses is not valid JSON/);
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

  it("refuses an app that writes to Analytics Engine while the probe found it off", async () => {
    const f = await buildArtifactFixture({ catalog: { requires: ["analytics-engine"] } });
    const h = harness(f);
    const probes = {
      checkedAt: NOW.toISOString(),
      r2: { state: "enabled" },
      containers: { state: "needs-workers-paid" },
      workersPlan: { state: "free" },
    };
    await writeSettings(createDb(env.DB), {
      [SETTING.accountCapabilities]: JSON.stringify({
        ...probes,
        analyticsEngine: { state: "not-enabled" },
      }),
    });
    await expect(startInstallCore(h.deps, input({ requirementsConfirmed: true }))).rejects.toThrow(
      "Cut writes to Analytics Engine, which is not turned on for this account. Turn on Analytics Engine once in the dashboard, then choose Check again on Your account.",
    );
    expect(h.created).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>();
    expect(rows?.n).toBe(0);

    // Turned on and re-checked: the install goes ahead.
    await writeSettings(createDb(env.DB), {
      [SETTING.accountCapabilities]: JSON.stringify({
        ...probes,
        analyticsEngine: { state: "enabled" },
      }),
    });
    await startInstallCore(h.deps, input({ requirementsConfirmed: true }));
    expect(h.created).toHaveLength(1);
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

    describe("for an app that needs every name under its hostname", () => {
      const wildcardApp = {
        catalog: {
          install: {
            tier: "artifact" as const,
            packageManager: "pnpm" as const,
            wranglerConfig: "wrangler.jsonc",
            wildcardHostname: { reason: "Each tunnel gets its own address." },
          },
        },
      };

      it("passes a wildcard domain to the job, lower-cased", async () => {
        const h = harness(await buildArtifactFixture(wildcardApp));
        await startInstallCore(
          h.deps,
          input({
            domain: { kind: "wildcard", zoneId: "z1", hostname: "Tunnels.Example.com" },
          }),
        );
        expect(h.created[0]?.params.domain).toEqual({
          kind: "wildcard",
          zoneId: "z1",
          hostname: "tunnels.example.com",
        });
      });

      it("refuses one exact hostname, and an external domain with the Enterprise reason", async () => {
        const h = harness(await buildArtifactFixture(wildcardApp));
        await expect(
          startInstallCore(
            h.deps,
            input({ domain: { kind: "custom", zoneId: "z1", hostname: "t.example.com" } }),
          ),
        ).rejects.toThrow("Choose a wildcard domain");
        await expect(
          startInstallCore(
            h.deps,
            input({
              domain: { kind: "external", hostname: "t.customer.test", validation: "http" },
            }),
          ),
        ).rejects.toThrow("on the Enterprise plan only");
        expect(h.created).toEqual([]);
      });

      it("refuses a wildcard domain for an app that answers on exact hostnames", async () => {
        const h = harness(await buildArtifactFixture());
        await expect(
          startInstallCore(
            h.deps,
            input({ domain: { kind: "wildcard", zoneId: "z1", hostname: "t.example.com" } }),
          ),
        ).rejects.toThrow("choose a custom domain instead");
      });
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

describe("startInstallCore, installing a failed install again", () => {
  /** A failed install of Cut ("old") with what it left: its Worker, a KV namespace, a secret. */
  async function seedFailed(
    opts: {
      status?: string;
      origin?: string;
      slug?: string;
      leftovers?: boolean;
      workerName?: string;
      autoUpdate?: string;
    } = {},
  ) {
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status,
         installed_at, updated_at, origin, catalog_id, auto_update)
       VALUES ('old', ?1, ?2, '0.9.0', 'https://x/z.zip', ?3, 1, 1, ?4, 'official', ?5)`,
    )
      .bind(
        opts.slug ?? "cut",
        opts.workerName ?? "cut",
        opts.status ?? "failed",
        opts.origin ?? "catalog",
        opts.autoUpdate ?? "off",
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json, error) VALUES ('oldjob', 'old', 'install', 'failed', '{}', 'preflight checks: no')",
    ).run();
    if (opts.leftovers === false) return;
    for (const [id, kind, name] of [
      ["r-worker", "worker", "cut"],
      ["r-kv", "kv", "cut-cut-kv"],
      ["r-secret", "secret", "ADMIN_PASSWORD"],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO resources (id, install_id, kind, name, cf_id, created_at) VALUES (?1, 'old', ?2, ?3, ?4, 1)",
      )
        .bind(id, kind, name, kind === "kv" ? "kv-1" : null)
        .run();
    }
  }

  const status = async (id: string) =>
    (await env.DB.prepare("SELECT status FROM installs WHERE id = ?1").bind(id).first())?.status;

  it("records the removal of what it left, keeping nothing, and the new install that waits for it", async () => {
    await seedFailed();
    const f = await buildArtifactFixture();
    const h = harness(f);
    const result = await startInstallCore(
      // The failed install's Worker is still in the account: no reason to refuse.
      { ...h.deps, listAccountWorkers: async () => ["appflare", "cut"] },
      input({ replaces: "old" }),
    );
    expect(result).toEqual({ installId: "id1", jobId: "id2" });
    // The removal first, then the install, which carries its id.
    expect(h.all.map((c) => c.params.kind)).toEqual(["uninstall", "install"]);
    expect(h.all[0]).toEqual({
      id: "id3",
      params: { kind: "uninstall", jobId: "id3", installId: "old", deleteResources: ["r-kv"] },
    });
    expect(h.created[0]?.params.cleanupJob).toBe("id3");
    expect(await status("old")).toBe("uninstalling");
    expect(await status("id1")).toBe("installing");
    const removal = await env.DB.prepare(
      "SELECT kind, status, input_json, workflow_instance_id FROM jobs WHERE id = 'id3'",
    ).first<{ input_json: string }>();
    expect(removal).toMatchObject({
      kind: "uninstall",
      status: "queued",
      workflow_instance_id: "id3",
    });
    expect(JSON.parse(removal?.input_json ?? "{}")).toEqual({
      installId: "old",
      deleteResources: ["r-kv"],
      retry: false,
      replacedBy: "id1",
    });
    // Nothing kept: no resource of it is marked retained.
    const kept = await env.DB.prepare(
      "SELECT count(*) AS n FROM resources WHERE retained_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(kept?.n).toBe(0);
    // The automatic-update choice carries over; the job's record names what it replaces.
    const row = await env.DB.prepare("SELECT auto_update FROM installs WHERE id = 'id1'").first();
    expect(row?.auto_update).toBe("off");
    const job = await env.DB.prepare("SELECT input_json FROM jobs WHERE id = 'id2'").first<{
      input_json: string;
    }>();
    expect(JSON.parse(job?.input_json ?? "{}")).toMatchObject({
      replaces: "old",
      cleanupJob: "id3",
    });
  });

  it("retires a failed install that left nothing at once, under another Worker name too", async () => {
    await seedFailed({ leftovers: false });
    const f = await buildArtifactFixture();
    const h = harness(f);
    await startInstallCore(h.deps, input({ replaces: "old", workerName: "links" }));
    expect(h.all.map((c) => c.params.kind)).toEqual(["install"]);
    expect(h.created[0]?.params.cleanupJob).toBeUndefined();
    expect(await status("old")).toBe("uninstalled");
    expect(await status("id1")).toBe("installing");
  });

  it("needs no removal when only secret records are left, its Worker being gone", async () => {
    await seedFailed({ leftovers: false });
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, name, created_at, deleted_at) VALUES
         ('r-worker', 'old', 'worker', 'cut', 1, 2), ('r-secret', 'old', 'secret', 'ADMIN_PASSWORD', 1, NULL)`,
    ).run();
    const f = await buildArtifactFixture();
    const h = harness(f);
    await startInstallCore(h.deps, input({ replaces: "old" }));
    expect(h.all.map((c) => c.params.kind)).toEqual(["install"]);
    expect(await status("old")).toBe("uninstalled");
    const secret = await env.DB.prepare(
      "SELECT deleted_at FROM resources WHERE id = 'r-secret'",
    ).first<{ deleted_at: number | null }>();
    expect(secret?.deleted_at).toBe(NOW.getTime());
  });

  it("refuses what cannot be installed again, before anything is recorded", async () => {
    const f = await buildArtifactFixture();
    for (const [seed, message] of [
      [{ status: "installed" }, "Only an install that did not finish can be installed again."],
      [{ origin: "repository" }, "Install again works for apps from a catalog."],
      [{ slug: "other" }, "Install again installs the same app again"],
    ] as const) {
      await reset();
      await createMigrator(migrations).ensure(env.DB);
      await seedFailed(seed);
      const h = harness(f);
      await expect(startInstallCore(h.deps, input({ replaces: "old" }))).rejects.toThrow(message);
      expect(h.all).toEqual([]);
      expect(await env.DB.prepare("SELECT id FROM installs WHERE id = 'id1'").first()).toBeNull();
    }
    // A job of it running.
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await seedFailed();
    await env.DB.prepare("UPDATE jobs SET status = 'running' WHERE id = 'oldjob'").run();
    await expect(startInstallCore(harness(f).deps, input({ replaces: "old" }))).rejects.toThrow(
      "A job of this install is running.",
    );
    expect(await status("old")).toBe("failed");
  });

  it("without `replaces`, a failed install that left things still blocks its Worker name", async () => {
    await seedFailed();
    const f = await buildArtifactFixture();
    await expect(startInstallCore(harness(f).deps, input())).rejects.toThrow(
      'A failed install of the Worker "cut" still owns resources in this account. Uninstall it first.',
    );
  });

  it("when the removal cannot start, fails the new install and leaves the old one to finish uninstalling", async () => {
    await seedFailed();
    const f = await buildArtifactFixture();
    const h = harness(f, async () => {
      throw new Error("Workflows is unavailable");
    });
    await expect(startInstallCore(h.deps, input({ replaces: "old" }))).rejects.toThrow(
      "start: could not start removing the install that did not finish: Workflows is unavailable",
    );
    expect(h.all.map((c) => c.params.kind)).toEqual(["uninstall"]);
    expect(await status("old")).toBe("uninstalling");
    expect(await status("id1")).toBe("failed");
    const jobs = await env.DB.prepare("SELECT id, status FROM jobs ORDER BY id").all();
    expect(jobs.results).toEqual([
      { id: "id2", status: "failed" },
      { id: "id3", status: "failed" },
      { id: "oldjob", status: "failed" },
    ]);
  });
});
