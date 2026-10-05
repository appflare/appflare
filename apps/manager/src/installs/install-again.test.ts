import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { baseCatalog } from "../test/artifact-fixture";
import {
  type InstallAgainRecord,
  installAgainHref,
  installAgainPrefill,
  offersInstallAgain,
  reenterNote,
} from "./install-again";
import { readInstallAgain } from "./install-again.server";
import type { InstallVarField } from "./install-vars";

const field = (over: Partial<InstallVarField> & { name: string }): InstallVarField => ({
  label: over.name,
  required: false,
  kind: "text",
  shownDefault: "",
  options: null,
  ...over,
});

const record = (over: Partial<InstallAgainRecord> = {}): InstallAgainRecord => ({
  installId: "old",
  appKey: "cut",
  label: "Team links",
  version: "1.0.0",
  workerName: "links",
  displayName: "Team links",
  vars: { HOME_PAGE: "admin" },
  access: false,
  domain: null,
  emailZoneId: null,
  autoUpdate: "inherit",
  leftovers: [],
  failedJobId: "job1",
  refusal: null,
  ...over,
});

const target = (over: Partial<Parameters<typeof installAgainPrefill>[1]> = {}) => ({
  catalog: baseCatalog(),
  version: "1.0.0",
  varFields: [field({ name: "HOME_PAGE", label: "Home page" })],
  defaultWorkerName: "cut",
  fixedWorkerName: false,
  ...over,
});

describe("installAgainPrefill", () => {
  it("starts from every choice of last time when nothing changed", () => {
    const { prefill, changes } = installAgainPrefill(
      record({
        access: true,
        domain: { kind: "custom", zoneId: "z1", hostname: "go.example.com" },
      }),
      target(),
    );
    expect(changes).toEqual([]);
    expect(prefill).toEqual({
      replaces: "old",
      workerName: "links",
      displayName: "Team links",
      vars: { HOME_PAGE: "admin" },
      access: true,
      domain: { kind: "custom", zoneId: "z1", hostname: "go.example.com" },
      emailZoneId: null,
    });
  });

  it("says what changed in the catalog and leaves out what no longer applies", () => {
    const { prefill, changes } = installAgainPrefill(
      record({
        version: "0.9.0",
        vars: { HOME_PAGE: "admin", OLD: "x", MODE: "fast", PUBLIC_KEY: "derived" },
        domain: { kind: "custom", zoneId: "z1", hostname: "go.example.com" },
        emailZoneId: "z2",
      }),
      target({
        catalog: baseCatalog({
          install: {
            packageManager: "pnpm",
            wranglerConfig: "wrangler.jsonc",
            wildcardHostname: { reason: "Every tunnel gets a name." },
          },
          access: { mode: "required" },
          requires: ["access"],
        }),
        varFields: [
          field({ name: "HOME_PAGE", label: "Home page" }),
          field({
            name: "MODE",
            label: "Mode",
            options: [{ value: "slow", label: "Slow" }],
          }),
          field({ name: "PUBLIC_KEY", label: "Public key", derivedFrom: "PRIVATE_KEY" }),
        ],
      }),
    );
    expect(prefill.vars).toEqual({ HOME_PAGE: "admin" });
    expect(prefill.access).toBe(true);
    expect(prefill.domain).toBeNull();
    expect(prefill.emailZoneId).toBeNull();
    expect(changes).toEqual([
      "The catalog has version 1.0.0 now; the install that did not finish tried 0.9.0. This installs 1.0.0.",
      "A setting from last time is no longer part of Cut, so it is left out: OLD.",
      "This version does not accept what was entered last time for Mode; it starts from the default.",
      "Cut must run behind Cloudflare Access now, so protection is on.",
      "Cut needs every name under its hostname now, so go.example.com is left out. Choose a wildcard domain.",
      "Cut no longer receives email, so no zone is needed.",
    ]);
  });

  it("takes the fixed Worker name of an app that only works under one", () => {
    const { prefill, changes } = installAgainPrefill(
      record({ workerName: "links" }),
      target({ fixedWorkerName: true, defaultWorkerName: "cut" }),
    );
    expect(prefill.workerName).toBe("cut");
    expect(changes).toEqual(['Cut only works as the Worker "cut" now, so the address changes.']);
  });
});

describe("reenterNote", () => {
  it("names database connections only: secrets are said next to their fields", () => {
    expect(reenterNote(baseCatalog())).toBeNull();
    expect(
      reenterNote(
        baseCatalog({
          resources: { hyperdrive: { DB: { protocol: "postgres" } } },
        } as Parameters<typeof baseCatalog>[0]),
      ),
    ).toBe("Appflare never stores database connection strings, so enter them again.");
  });
});

describe("installAgainHref and offersInstallAgain", () => {
  it("opens the app's catalog page with the form, for catalog apps that did not finish only", () => {
    expect(installAgainHref("01J", "team:cut")).toBe("/catalog/team:cut?again=01J#install");
    expect(offersInstallAgain({ status: "failed", origin: "catalog" })).toBe(true);
    expect(offersInstallAgain({ status: "failed", origin: "repository" })).toBe(false);
    expect(offersInstallAgain({ status: "installed", origin: "catalog" })).toBe(false);
  });
});

describe("readInstallAgain", () => {
  beforeEach(async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
  });

  async function seed(status = "failed") {
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, display_name, catalog_version, artifact_url,
         status, config_json, installed_at, updated_at, catalog_id, auto_update)
       VALUES ('old', 'cut', 'links', 'Team links', '1.0.0', 'https://x/z.zip', ?1,
         '{"HOME_PAGE":"admin"}', 1, 1, 'team', 'on')`,
    )
      .bind(status)
      .run();
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('job1', 'old', 'install', 'failed', ?1)",
    )
      .bind(
        JSON.stringify({
          slug: "cut",
          version: "1.0.0",
          workerName: "links",
          secrets: ["ADMIN_PASSWORD"],
          vars: { HOME_PAGE: "admin" },
          paidConfirmed: true,
          requirementsConfirmed: true,
          emailRouting: { zoneId: "z2" },
          domain: { kind: "external", hostname: "go.customer.net", validation: "http" },
          access: true,
        }),
      )
      .run();
    for (const [id, kind, name, deleted] of [
      ["r1", "worker", "links", null],
      ["r2", "worker", "links-api", null],
      ["r3", "kv", "links-cut-kv", null],
      ["r4", "secret", "ADMIN_PASSWORD", null],
      ["r5", "d1", "links-db", 5],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO resources (id, install_id, kind, name, created_at, deleted_at) VALUES (?1, 'old', ?2, ?3, 1, ?4)",
      )
        .bind(id, kind, name, deleted)
        .run();
    }
  }

  it("reads the choices the install job recorded and what is still in the account", async () => {
    await seed();
    expect(await readInstallAgain(env.DB, "old")).toEqual({
      installId: "old",
      appKey: "team:cut",
      label: "Team links",
      version: "1.0.0",
      workerName: "links",
      displayName: "Team links",
      vars: { HOME_PAGE: "admin" },
      access: true,
      domain: { kind: "external", hostname: "go.customer.net", validation: "http" },
      emailZoneId: "z2",
      autoUpdate: "on",
      leftovers: [
        { kind: "worker", name: "links" },
        { kind: "worker", name: "links-api" },
        { kind: "kv", name: "links-cut-kv" },
      ],
      failedJobId: "job1",
      refusal: null,
    });
    expect(await readInstallAgain(env.DB, "missing")).toBeNull();
  });

  it("names an install without a display name by the app's name its job recorded", async () => {
    await seed();
    await env.DB.prepare("UPDATE installs SET display_name = NULL WHERE id = 'old'").run();
    await env.DB.prepare(
      "UPDATE jobs SET input_json = json_set(input_json, '$.appName', 'Cut') WHERE id = 'job1'",
    ).run();
    expect((await readInstallAgain(env.DB, "old"))?.label).toBe("Cut");
    // A job from before the name was recorded: the slug, as before.
    await env.DB.prepare(
      "UPDATE jobs SET input_json = json_remove(input_json, '$.appName') WHERE id = 'job1'",
    ).run();
    expect((await readInstallAgain(env.DB, "old"))?.label).toBe("cut");
  });

  it("says why an install that finished cannot be installed again", async () => {
    await seed("installed");
    const read = await readInstallAgain(env.DB, "old");
    expect(read?.refusal).toBe(
      "Only an install that did not finish can be installed again. This one finished, or it was removed or installed again already.",
    );
    expect(read?.leftovers).toEqual([]);
  });
});
