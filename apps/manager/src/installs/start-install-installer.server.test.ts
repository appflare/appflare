import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type CatalogManifest,
  catalogManifestSchema,
  type IndexApp,
  selfDeployingStage,
} from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import type { InstallJobParams } from "../jobs/install";
import { baseCatalog, buildArtifactFixture } from "../test/artifact-fixture";
import { type StartInstallInput, startInstallInput } from "./install-input";
import { catalogOnlyManifest, StartInstallError, startInstallCore } from "./start-install.server";

/**
 * Starting the install of an app that deploys itself: the install id the
 * form was given when it loaded (whose stage it showed), and Workers for
 * Platforms, refused before anything runs when the account lacks it.
 */

const PIN = "84e4705503ceaef54d1b284c167de9942563cdae";
/** The id the page made, as `ulidx` makes them. */
const FORM_ID = "01JZ8Q4W3M5N6P7R8S9T0V1X2Y";
const STAGE = "appflare-9t0v1x2y";

function catalog(requires: string[] = ["containers", "workers-for-platforms"]): CatalogManifest {
  const base = baseCatalog();
  return catalogManifestSchema.parse({
    ...base,
    source: { ref: "v1.0.0", sha: PIN },
    install: {
      tier: "self-deploying",
      packageManager: "pnpm",
      workerName: "cut",
      selfDeploying: {
        tool: "alchemy",
        deployCommand: ["pnpm", "alchemy", "deploy", "--yes"],
        destroyCommand: ["pnpm", "alchemy", "destroy", "--yes"],
        workerNames: ["cut-{{stage}}"],
      },
    },
    plan: "paid",
    requires,
    tokenPermissions: [
      { group: "Workers Scripts", scope: "account", access: "edit", reason: "Deploys the app." },
    ],
  });
}

function indexApp(c: CatalogManifest): IndexApp {
  return {
    slug: "cut",
    name: "Cut",
    summary: c.summary,
    tagline: c.tagline,
    addedAt: "2026-09-01T00:00:00Z",
    version: "1.0.0",
    revision: c.revision,
    tier: "self-deploying",
    plan: "paid",
    requires: c.requires,
    services: ["containers"],
    categories: c.categories,
    license: c.license,
    authors: [{ name: "MendyLanda", github: "MendyLanda" }],
    lastVerified: null,
    maintainers: ["MendyLanda"],
    build: {
      pin: PIN,
      manifest: "https://appflare.github.io/catalog/apps/cut/appflare.json",
      manifestDigest: "a".repeat(64),
      expectedMinutes: 12,
    },
  };
}

function start(input: Partial<StartInstallInput> = {}, c: CatalogManifest = catalog()) {
  const created: InstallJobParams[] = [];
  let n = 0;
  const app = indexApp(c);
  const run = startInstallCore(
    {
      db: env.DB,
      loadApp: async () => ({ app, manifest: catalogOnlyManifest(c) }),
      sandboxConnected: async () => true,
      createJob: async (id, params) => {
        if (params.kind === "install") created.push(params);
        return { id };
      },
      listAccountWorkers: async () => [],
      newId: () => `ID${String(++n).padStart(24, "0")}`,
    },
    {
      slug: "cut",
      workerName: "cut",
      secrets: { ADMIN_PASSWORD: "hunter2-hunter2" },
      vars: {},
      paidConfirmed: true,
      requirementsConfirmed: true,
      buildConfirmed: true,
      appToken: "app-token-DO-NOT-LEAK",
      ...input,
    },
  );
  return { run, created };
}

async function probes(workersForPlatforms: unknown) {
  await writeSettings(createDb(env.DB), {
    [SETTING.accountCapabilities]: JSON.stringify({
      checkedAt: "2026-10-15T12:00:00.000Z",
      r2: { state: "enabled" },
      containers: { state: "available" },
      workersPlan: { state: "paid" },
      ...(workersForPlatforms === undefined ? {} : { workersForPlatforms }),
    }),
  });
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("the install id the form showed the stage of", () => {
  it("is the install's id, so its Workers are named after the stage the admin saw", async () => {
    expect(selfDeployingStage(FORM_ID)).toBe(STAGE);
    const { run } = start({ installId: FORM_ID });
    const { installId } = await run;
    expect(installId).toBe(FORM_ID);
    const row = await env.DB.prepare("SELECT id, worker_name FROM installs").first<{
      id: string;
      worker_name: string;
    }>();
    expect(row).toEqual({ id: FORM_ID, worker_name: `cut-${STAGE}` });
  });

  it("is made by the install when an older form sends none", async () => {
    const { installId } = await start().run;
    expect(installId).toBe(`ID${"1".padStart(24, "0")}`);
  });

  it("is refused once used, and when another install already has its stage", async () => {
    await start({ installId: FORM_ID }).run;
    await expect(start({ installId: FORM_ID }).run).rejects.toThrow(
      "This install was started already. Reload the page to install the app again.",
    );
    // Another id that ends the same way: the same stage, so the same Workers.
    const twin = "01K0000000000000009T0V1X2Y";
    expect(selfDeployingStage(twin)).toBe(STAGE);
    await expect(start({ installId: twin }).run).rejects.toThrow(
      "Another install already has the stage this form showed.",
    );
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("must be a ULID, and is only for an app that deploys itself", async () => {
    const base = {
      slug: "cut",
      workerName: "cut",
      secrets: {},
      vars: {},
      paidConfirmed: false,
    };
    expect(startInstallInput.safeParse({ ...base, installId: FORM_ID }).success).toBe(true);
    for (const installId of [
      "id1",
      FORM_ID.toLowerCase(),
      `${FORM_ID}0`,
      "01JZ8Q4W3M5N6P7R8S9T0V1XIU",
    ]) {
      expect(startInstallInput.safeParse({ ...base, installId }).success, installId).toBe(false);
    }
    const f = await buildArtifactFixture();
    await expect(
      startInstallCore(
        {
          db: env.DB,
          loadApp: async () => ({ app: f.index, manifest: f.manifest }),
          createJob: async (id) => ({ id }),
        },
        {
          slug: "cut",
          workerName: "cut",
          secrets: { ADMIN_PASSWORD: "hunter2-hunter2" },
          vars: { HOME_PAGE: "admin" },
          paidConfirmed: true,
          requirementsConfirmed: true,
          installId: FORM_ID,
        },
      ),
    ).rejects.toThrow(
      new StartInstallError("Cut takes no install id; only an app that deploys itself does."),
    );
  });
});

describe("an app that needs Workers for Platforms", () => {
  it("is refused before anything runs while the probe found the account without it", async () => {
    await probes({ state: "not-available" });
    const { run, created } = start({ installId: FORM_ID });
    await expect(run).rejects.toThrow(
      "Cut needs Workers for Platforms, which this account does not have. Buy Workers for Platforms in the Cloudflare dashboard, then choose Check again on Your account.",
    );
    expect(created).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("installs once the account has it, or when the probe could not tell", async () => {
    await probes({ state: "available" });
    expect((await start({ installId: FORM_ID }).run).installId).toBe(FORM_ID);
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await probes({ state: "unknown", reason: "error", detail: "HTTP 503" });
    await expect(start().run).resolves.toMatchObject({ jobId: expect.any(String) });
  });

  it("does not hold up an app that does not list it", async () => {
    await probes({ state: "not-available" });
    await expect(start({}, catalog(["containers"])).run).resolves.toMatchObject({
      jobId: expect.any(String),
    });
  });
});
