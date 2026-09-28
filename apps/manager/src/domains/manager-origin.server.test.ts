import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { MANAGER_URL_KEY, managerOrigin } from "./manager-origin.server";

const request = (url: string) => new Request(url);

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("managerOrigin", () => {
  it("is Appflare's custom domain whenever it has one", async () => {
    await writeSettings(createDb(env.DB), {
      [SETTING.managerHostname]: "appflare.example.com",
      [SETTING.accessDomain]: "appflare.ada.workers.dev",
      [SETTING.workerName]: "appflare",
      [SETTING.accountSubdomain]: "ada",
    });
    expect(await managerOrigin(env)).toBe("https://appflare.example.com");
    expect(await managerOrigin(env, request("https://appflare.ada.workers.dev/settings"))).toBe(
      "https://appflare.example.com",
    );
  });

  it("is the address serving the request while there is none", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.workerName]: "appflare" });
    expect(await managerOrigin(env, request("https://manage.example.org/settings/account"))).toBe(
      "https://manage.example.org",
    );
    expect(await managerOrigin(env, request("http://localhost:5173/"))).toBe(
      "http://localhost:5173",
    );
  });

  it("without a request: the remembered address, then Access, then workers.dev", async () => {
    expect(await managerOrigin(env)).toBeNull();
    await writeSettings(createDb(env.DB), {
      [SETTING.workerName]: "appflare",
      [SETTING.accountSubdomain]: "ada",
    });
    expect(await managerOrigin(env)).toBe("https://appflare.ada.workers.dev");
    await writeSettings(createDb(env.DB), { [SETTING.accessDomain]: "gate.example.org" });
    expect(await managerOrigin(env)).toBe("https://gate.example.org");
    await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, 0)")
      .bind(MANAGER_URL_KEY, "https://used.example.org")
      .run();
    expect(await managerOrigin(env)).toBe("https://used.example.org");
  });
});
