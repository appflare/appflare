import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import {
  type AccessConfig,
  clearAccessConfig,
  readAccessConfig,
  readAccessSignInState,
  writeAccessConfig,
  writeAccessSignIn,
} from "./config";

const CONFIG: AccessConfig = {
  appId: "app-1",
  policyId: "pol-1",
  healthAppId: "app-health",
  aud: "aud-tag",
  teamDomain: "team.cloudflareaccess.com",
  domain: "appflare.example.workers.dev",
  enabledAt: "2026-09-23T12:00:00.000Z",
};

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("Access settings", () => {
  it("reads as off when nothing is stored", async () => {
    expect(await readAccessConfig(env.DB)).toBeNull();
  });

  it("round-trips every value through the settings table", async () => {
    await writeAccessConfig(env.DB, CONFIG);
    expect(await readAccessConfig(env.DB)).toEqual(CONFIG);
    const rows = await readSettings(createDb(env.DB), [
      SETTING.accessAud,
      SETTING.accessTeamDomain,
    ]);
    expect(rows).toEqual({
      access_aud: "aud-tag",
      access_team_domain: "team.cloudflareaccess.com",
    });
  });

  it("stores a missing health application as null", async () => {
    await writeAccessConfig(env.DB, { ...CONFIG, healthAppId: null });
    expect((await readAccessConfig(env.DB))?.healthAppId).toBeNull();
  });

  it("clears only its own rows", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.workerName]: "appflare" });
    await writeAccessConfig(env.DB, CONFIG);
    await clearAccessConfig(env.DB);
    expect(await readAccessConfig(env.DB)).toBeNull();
    expect(await readSettings(createDb(env.DB), [SETTING.workerName])).toEqual({
      worker_name: "appflare",
    });
  });

  it("treats a partly present row set as on, so a damaged state fails closed", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.accessAppId]: "app-1" });
    const config = await readAccessConfig(env.DB);
    expect(config).not.toBeNull();
    expect(config?.aud).toBe("");
  });

  it("does not count the sign-in switch alone as protection being on", async () => {
    await writeAccessSignIn(env.DB, true);
    expect(await readAccessConfig(env.DB)).toBeNull();
    expect(await readAccessSignInState(env.DB)).toEqual({ config: null, signInEnabled: false });
  });

  it("reads the sign-in switch with the protection, and turns it off", async () => {
    await writeAccessConfig(env.DB, CONFIG);
    expect(await readAccessSignInState(env.DB)).toEqual({ config: CONFIG, signInEnabled: false });
    await writeAccessSignIn(env.DB, true, new Date("2026-09-24T08:00:00.000Z"));
    expect(await readAccessSignInState(env.DB)).toEqual({ config: CONFIG, signInEnabled: true });
    expect(await readSettings(createDb(env.DB), [SETTING.accessSignInEnabledAt])).toEqual({
      access_sign_in_enabled_at: "2026-09-24T08:00:00.000Z",
    });
    await writeAccessSignIn(env.DB, false);
    expect(await readAccessSignInState(env.DB)).toEqual({ config: CONFIG, signInEnabled: false });
  });

  it("removes the sign-in switch when protection is cleared", async () => {
    await writeAccessConfig(env.DB, CONFIG);
    await writeAccessSignIn(env.DB, true);
    await clearAccessConfig(env.DB);
    expect(await readSettings(createDb(env.DB), [SETTING.accessSignInEnabledAt])).toEqual({});
    // Turning protection on again starts with the switch off.
    await writeAccessConfig(env.DB, CONFIG);
    expect((await readAccessSignInState(env.DB)).signInEnabled).toBe(false);
  });

  it("is removed by the lockout recovery's statement", async () => {
    await writeAccessConfig(env.DB, CONFIG);
    await writeAccessSignIn(env.DB, true);
    await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'access_%'").run();
    expect(await readAccessSignInState(env.DB)).toEqual({ config: null, signInEnabled: false });
    expect(await readSettings(createDb(env.DB), [SETTING.accessSignInEnabledAt])).toEqual({});
  });
});
