import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator, KNOWN_SCHEMA_VERSION, schemaDowngrade } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import {
  deployButtonInstalled,
  deployCopyCleanup,
  deployCopySearchUrl,
  INSTALL_SOURCE_DEPLOY_BUTTON,
  workerSettingsUrl,
} from "./deploy-copy";
import { dismissDeployCopyCleanup, readDeployCopyCleanup } from "./deploy-copy.server";

describe("deployButtonInstalled", () => {
  it("is true for the deploy repository's marker", () => {
    expect(deployButtonInstalled({ APPFLARE_INSTALL_SOURCE: INSTALL_SOURCE_DEPLOY_BUTTON })).toBe(
      true,
    );
    expect(deployButtonInstalled({ APPFLARE_INSTALL_SOURCE: " deploy-button\n" })).toBe(true);
  });

  it("tolerates the marker as edited on the button's form: any case, any value starting with deploy", () => {
    for (const edited of ["Deploy-Button", "DEPLOY", "deploy", "deploy_button", "Deploybutton"]) {
      expect(deployButtonInstalled({ APPFLARE_INSTALL_SOURCE: edited }), edited).toBe(true);
    }
  });

  it("is false without the marker or for another source", () => {
    expect(deployButtonInstalled({})).toBe(false);
    expect(deployButtonInstalled({ APPFLARE_INSTALL_SOURCE: "" })).toBe(false);
    expect(deployButtonInstalled({ APPFLARE_INSTALL_SOURCE: "cli" })).toBe(false);
    expect(deployButtonInstalled({ APPFLARE_INSTALL_SOURCE: "button-deploy" })).toBe(false);
  });
});

describe("the cleanup links", () => {
  it("open the Builds section of the Worker's settings, where Builds can be disconnected", () => {
    expect(workerSettingsUrl("0123abc", "appflare")).toBe(
      "https://dash.cloudflare.com/0123abc/workers/services/view/appflare/production/settings#builds",
    );
    expect(workerSettingsUrl(null, "appflare")).toBe(
      "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
    );
    expect(workerSettingsUrl("0123abc", null)).toBe(
      "https://dash.cloudflare.com/?to=/0123abc/workers-and-pages",
    );
  });

  it("search the visitor's private repositories by the Worker's name", () => {
    const url = new URL(deployCopySearchUrl("my-appflare"));
    expect(url.origin + url.pathname).toBe("https://github.com/search");
    expect(url.searchParams.get("q")).toBe("my-appflare in:name is:private");
    expect(url.searchParams.get("type")).toBe("repositories");
    expect(new URL(deployCopySearchUrl(null)).searchParams.get("q")).toBe(
      "appflare in:name is:private",
    );
  });
});

describe("deployCopyCleanup", () => {
  const base = {
    installSource: "deploy-button",
    dismissedAt: undefined,
    isAdmin: true,
    accountId: "acc",
    workerName: "appflare",
  };

  it("is shown to admins of a manager the button deployed", () => {
    expect(deployCopyCleanup(base)).toEqual({
      workerName: "appflare",
      workerSettingsUrl: workerSettingsUrl("acc", "appflare"),
      repositorySearchUrl: deployCopySearchUrl("appflare"),
    });
  });

  it("is not shown on other managers, to members, or once dismissed", () => {
    expect(deployCopyCleanup({ ...base, installSource: undefined })).toBeNull();
    expect(deployCopyCleanup({ ...base, installSource: "cli" })).toBeNull();
    expect(deployCopyCleanup({ ...base, isAdmin: false })).toBeNull();
    expect(deployCopyCleanup({ ...base, dismissedAt: "2026-09-24T00:00:00.000Z" })).toBeNull();
  });
});

describe("the card's state in D1", () => {
  beforeEach(async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
  });

  const buttonEnv = () => ({ DB: env.DB, APPFLARE_INSTALL_SOURCE: "deploy-button" });

  it("uses the account and Worker the token step recorded", async () => {
    await writeSettings(createDb(env.DB), {
      [SETTING.accountId]: "acc",
      [SETTING.workerName]: "my-appflare",
    });
    const card = await readDeployCopyCleanup(buttonEnv(), true);
    expect(card?.workerName).toBe("my-appflare");
    expect(card?.workerSettingsUrl).toBe(workerSettingsUrl("acc", "my-appflare"));
  });

  it("stays dismissed for every admin", async () => {
    expect(await readDeployCopyCleanup(buttonEnv(), true)).not.toBeNull();
    await dismissDeployCopyCleanup(buttonEnv(), new Date("2026-09-24T10:00:00Z"));
    await dismissDeployCopyCleanup(buttonEnv(), new Date("2026-09-25T10:00:00Z"));
    expect(await readDeployCopyCleanup(buttonEnv(), true)).toBeNull();
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
      .bind(SETTING.deployCopyDismissedAt)
      .first<{ value: string }>();
    expect(row?.value).toBe("2026-09-24T10:00:00.000Z");
  });

  it("is shown when the marker was retyped on the button's form", async () => {
    const card = await readDeployCopyCleanup(
      { DB: env.DB, APPFLARE_INSTALL_SOURCE: "Deploy-Button" },
      true,
    );
    expect(card).not.toBeNull();
  });

  it("is never read for managers the button did not deploy", async () => {
    expect(await readDeployCopyCleanup({ DB: env.DB }, true)).toBeNull();
  });
});

describe("schemaDowngrade", () => {
  it("reports a database migrated by a newer version", () => {
    expect(schemaDowngrade(17, 16)).toEqual({ recorded: 17, known: 16 });
    expect(schemaDowngrade(16, 16)).toBeNull();
    expect(schemaDowngrade(3, 16)).toBeNull();
    expect(schemaDowngrade(KNOWN_SCHEMA_VERSION)).toBeNull();
    expect(schemaDowngrade(KNOWN_SCHEMA_VERSION + 1)).toEqual({
      recorded: KNOWN_SCHEMA_VERSION + 1,
      known: KNOWN_SCHEMA_VERSION,
    });
  });

  it("is detected when the isolate first migrates", async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    // A newer version applied one more migration than this build knows.
    await env.DB.prepare("UPDATE settings SET value = ?1 WHERE key = 'schema_version'")
      .bind(String(migrations.length + 1))
      .run();
    const outcome = await createMigrator(migrations).ensure(env.DB);
    expect(outcome).toEqual({ schemaVersion: migrations.length + 1, applied: [] });
    expect(schemaDowngrade(outcome.schemaVersion, migrations.length)).not.toBeNull();
  });
});
