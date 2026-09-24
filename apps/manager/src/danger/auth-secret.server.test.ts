import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { session, user } from "../db/schema";
import { SETTING, writeSettings } from "../db/settings";
import { tryAcquireSettingsLock } from "../db/settings-lock";
import { ACC, TOKEN } from "../test/fake-account";
import { fakeCloudflare } from "../test/fake-cloudflare";
import { addChannel } from "../test/notification-fixtures";
import {
  AUTH_SECRET_NAME,
  generateAuthSecret,
  ROTATION_MESSAGES,
  readAuthSecretRotatedAt,
  rotateAuthSecretCore,
} from "./auth-secret.server";

const NOW = new Date("2026-09-24T15:00:00.000Z");
const NEW_SECRET = "new-secret-value-DO-NOT-LEAK-0123456789abcdef";
const PUT_SECRET = `PUT /accounts/${ACC}/workers/scripts/appflare/secrets`;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: "appflare",
  });
  const at = new Date("2026-09-01T00:00:00Z");
  await createDb(env.DB)
    .insert(user)
    .values([
      {
        id: "u1",
        name: "Ada",
        email: "ada@example.com",
        role: "admin",
        isOwner: true,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "u2",
        name: "Bob",
        email: "bob@example.com",
        role: "member",
        createdAt: at,
        updatedAt: at,
      },
    ]);
  await createDb(env.DB)
    .insert(session)
    .values([
      {
        id: "s1",
        token: "t1",
        userId: "u1",
        expiresAt: new Date("2027-01-01Z"),
        createdAt: at,
        updatedAt: at,
      },
      {
        id: "s2",
        token: "t2",
        userId: "u2",
        expiresAt: new Date("2027-01-01Z"),
        createdAt: at,
        updatedAt: at,
      },
    ]);
});

function api(status = 200) {
  const cf = fakeCloudflare({
    [PUT_SECRET]:
      status === 200
        ? { result: { name: AUTH_SECRET_NAME, type: "secret_text" } }
        : { status, errors: [{ code: 10000, message: "Authentication error" }] },
  });
  return { cf, client: createClient({ accountId: ACC, token: TOKEN, fetch: cf.fetch }) };
}

describe("generateAuthSecret", () => {
  it("makes 32 random bytes as base64url, different every time", () => {
    const a = generateAuthSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateAuthSecret()).not.toBe(a);
  });
});

describe("rotateAuthSecretCore", () => {
  it("writes the new secret to the manager's Worker, records the time and signs everyone out", async () => {
    await addChannel();
    const { cf, client } = api();
    const result = await rotateAuthSecretCore({
      db: env.DB,
      api: client,
      now: () => NOW,
      generate: () => NEW_SECRET,
    });
    expect(result).toEqual({ rotatedAt: NOW.toISOString(), workerName: "appflare", channels: 1 });
    expect(cf.keys()).toEqual([PUT_SECRET]);
    expect(JSON.parse(cf.calls[0]?.body ?? "{}")).toEqual({
      name: AUTH_SECRET_NAME,
      text: NEW_SECRET,
      type: "secret_text",
    });
    expect(await readAuthSecretRotatedAt(env.DB)).toBe(NOW.toISOString());
    expect(await createDb(env.DB).select().from(session)).toEqual([]);
  });

  it("changes nothing when Cloudflare refuses the secret", async () => {
    const { client } = api(403);
    await expect(
      rotateAuthSecretCore({ db: env.DB, api: client, generate: () => NEW_SECRET }),
    ).rejects.toThrow("Authentication error");
    expect(await readAuthSecretRotatedAt(env.DB)).toBeNull();
    expect(await createDb(env.DB).select().from(session)).toHaveLength(2);
  });

  it("refuses a second rotation while one is running", async () => {
    await tryAcquireSettingsLock(env.DB, "auth_secret_lock", "other", 60_000);
    const { cf, client } = api();
    await expect(rotateAuthSecretCore({ db: env.DB, api: client })).rejects.toThrow(
      ROTATION_MESSAGES.busy,
    );
    expect(cf.calls).toEqual([]);
  });

  it("refuses before setup has recorded the Worker name", async () => {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'worker_name'").run();
    const { cf, client } = api();
    await expect(rotateAuthSecretCore({ db: env.DB, api: client })).rejects.toThrow(
      ROTATION_MESSAGES.noWorkerName,
    );
    expect(cf.calls).toEqual([]);
  });
});
