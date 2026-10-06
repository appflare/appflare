import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { baseCatalog } from "../test/artifact-fixture";
import {
  buildIdOfInput,
  type InstallAgainRecord,
  installAgainFitsBuild,
  installAgainHref,
  installAgainLink,
  installAgainPrefill,
  reenterNote,
} from "./install-again";
import { BUILD_GONE, readInstallAgain } from "./install-again.server";
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
  origin: "catalog",
  source: null,
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

  it("names a new build's version as the build's, not the catalog's", () => {
    const { changes } = installAgainPrefill(
      record({ version: "0.0.0-20260920.0123456" }),
      target({ version: "0.0.0-20260921.fedcba9", fromBuild: true }),
    );
    expect(changes).toEqual([
      "This build is version 0.0.0-20260921.fedcba9; the install that did not finish tried 0.0.0-20260920.0123456. This installs 0.0.0-20260921.fedcba9.",
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

describe("installAgainLink", () => {
  const install = {
    id: "01J",
    status: "failed",
    origin: "catalog",
    appKey: "team:cut",
    buildId: null,
  };

  it("opens the app's catalog page with the form, for catalog apps that did not finish", () => {
    expect(installAgainHref("01J", "team:cut")).toBe("/catalog/team:cut?again=01J#install");
    expect(installAgainLink(install)).toBe("/catalog/team:cut?again=01J#install");
    expect(installAgainLink({ ...install, status: "installed" })).toBeNull();
  });

  it("opens the review of the build an install from a repository was installed from", () => {
    const fromRepository = { ...install, origin: "repository", appKey: "repository:me/cut" };
    expect(installAgainLink({ ...fromRepository, buildId: "b1" })).toBe(
      "/catalog/source/b1?again=01J",
    );
    expect(installAgainLink({ ...install, origin: "source", buildId: "b1" })).toBe(
      "/catalog/source/b1?again=01J",
    );
    // No build recorded: nothing to open.
    expect(installAgainLink(fromRepository)).toBeNull();
    expect(
      installAgainLink({ ...fromRepository, buildId: "b1", status: "uninstalled" }),
    ).toBeNull();
  });

  it("reads the build an install job recorded", () => {
    expect(buildIdOfInput(JSON.stringify({ slug: "cut", buildId: "b1" }))).toBe("b1");
    expect(buildIdOfInput(JSON.stringify({ slug: "cut" }))).toBeNull();
    expect(buildIdOfInput("not json")).toBeNull();
    expect(buildIdOfInput(null)).toBeNull();
  });
});

describe("installAgainFitsBuild", () => {
  const source = (over: Partial<NonNullable<InstallAgainRecord["source"]>> = {}) =>
    record({
      appKey: "repository:me/cut",
      origin: "repository",
      source: {
        origin: "repository",
        repo: "me/cut",
        ref: "main",
        commit: null,
        buildId: "b1",
        build: { state: "ready" },
        ...over,
      },
    });
  const build = { id: "b1", purpose: "install", origin: "repository", repo: "me/cut", app: null };

  it("takes the build it was installed from and new builds of the same repository", () => {
    expect(installAgainFitsBuild(source(), build)).toBe(true);
    expect(installAgainFitsBuild(source(), { ...build, id: "b2" })).toBe(true);
    expect(installAgainFitsBuild(source(), { ...build, id: "b2", repo: "me/other" })).toBe(false);
    // A rebuild for an update, or a catalog app's install: never.
    expect(installAgainFitsBuild(source(), { ...build, id: "b2", purpose: "update" })).toBe(false);
    expect(installAgainFitsBuild(record(), build)).toBe(false);
  });

  it("matches a catalog app built from source by its app key", () => {
    const fromSource = record({
      appKey: "team:cut",
      origin: "source",
      source: {
        origin: "source",
        repo: "me/cut",
        ref: "v2",
        commit: null,
        buildId: "b1",
        build: { state: "ready" },
      },
    });
    const sourceBuild = { ...build, id: "b2", origin: "source", app: { slug: "team:cut" } };
    expect(installAgainFitsBuild(fromSource, sourceBuild)).toBe(true);
    expect(installAgainFitsBuild(fromSource, { ...sourceBuild, app: { slug: "cut" } })).toBe(false);
    expect(installAgainFitsBuild(fromSource, { ...sourceBuild, origin: "repository" })).toBe(false);
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
      origin: "catalog",
      source: null,
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

  describe("of an install from a repository", () => {
    const ZIP = "builds/old/0.0.0-1.abc/cut-0.0.0-1.abc.zip";
    const MANIFEST = "builds/old/0.0.0-1.abc/manifest.json";

    async function seedFromRepository(build: "used" | "discarded" | "none" = "used") {
      await env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status,
           installed_at, updated_at, build_kind, origin, source_url, source_ref, pin_sha)
         VALUES ('old', 'repository:me/cut', 'cut', '0.0.0-1.abc', ?1, 'failed', 1, 1, 'sandbox',
           'repository', 'https://github.com/me/cut', 'main', 'abc')`,
      )
        .bind(`https://sandbox/${ZIP}`)
        .run();
      await env.DB.prepare(
        "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('job1', 'old', 'install', 'failed', ?1)",
      )
        .bind(
          JSON.stringify({
            slug: "repository:me/cut",
            version: "0.0.0-1.abc",
            workerName: "cut",
            vars: {},
            origin: "repository",
            ...(build === "none" ? {} : { buildId: "b1" }),
          }),
        )
        .run();
      if (build === "none") return;
      await env.DB.prepare(
        `INSERT INTO source_builds (id, install_id, purpose, origin, repo, status, commit_sha, ref,
           version, digest, manifest_key, artifact_key, image, built_at, created_at, updated_at)
         VALUES ('b1', 'old', 'install', 'repository', 'me/cut', ?1, 'abc', 'main', '0.0.0-1.abc',
           'd', ?2, ?3, 'img', 1, 1, 1)`,
      )
        .bind(build, MANIFEST, ZIP)
        .run();
    }

    const base = {
      origin: "repository",
      repo: "me/cut",
      ref: "main",
      commit: "abc",
      buildId: "b1",
    };

    it("offers the build it was installed from while its files are there", async () => {
      await seedFromRepository();
      const asked: string[][] = [];
      const read = await readInstallAgain(env.DB, "old", {
        buildFiles: async (keys) => {
          asked.push(keys);
          return "present";
        },
      });
      expect(read?.refusal).toBeNull();
      expect(read?.origin).toBe("repository");
      expect(read?.source).toEqual({ ...base, build: { state: "ready" } });
      expect(asked).toEqual([[MANIFEST, ZIP]]);
    });

    it("says the build is gone when its files are, or sandbox builds are off", async () => {
      await seedFromRepository();
      const gone = async (files: "missing" | "no-sandbox") =>
        (await readInstallAgain(env.DB, "old", { buildFiles: async () => files }))?.source?.build;
      expect(await gone("missing")).toEqual({
        state: "gone",
        cause: "missing",
        reason: BUILD_GONE.missing,
      });
      expect(await gone("no-sandbox")).toEqual({
        state: "gone",
        cause: "no-sandbox",
        reason: BUILD_GONE.noSandbox,
      });
      const unknown = await readInstallAgain(env.DB, "old", {
        buildFiles: async () => {
          throw new Error("HTTP 500");
        },
      });
      expect(unknown?.source?.build).toEqual({ state: "unknown", reason: BUILD_GONE.unknown });
    });

    it("says the build is gone when Appflare has no usable record of it", async () => {
      for (const build of ["discarded", "none"] as const) {
        await reset();
        await createMigrator(migrations).ensure(env.DB);
        await seedFromRepository(build);
        const read = await readInstallAgain(env.DB, "old", { buildFiles: async () => "present" });
        expect(read?.source).toEqual({
          ...base,
          buildId: build === "none" ? null : "b1",
          build: { state: "gone", cause: "unrecorded", reason: BUILD_GONE.unrecorded },
        });
      }
    });
  });
});
