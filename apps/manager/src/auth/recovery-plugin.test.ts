import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { recoveryCodeSecretValue } from "@appflare/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { session } from "../db/schema";
import { RECOVERY_CODE_PATH } from "./recovery-messages";
import { RECOVERY_CODE_RATE_LIMIT } from "./recovery-plugin";
import { type Auth, createAuth } from "./server";

const BASE = "https://appflare.appflare-dev.workers.dev";
const SECRET = "test-only-better-auth-secret-0000000000000";
const OLD_PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new password";
const CODE = "ABCDE-FGHJK-LMNPQ-RSTUV";

function auth(accountSecret: string | undefined, onAccountCodeUsed = vi.fn()): Auth {
  return createAuth({
    db: createDb(env.DB),
    secret: SECRET,
    baseURL: BASE,
    recovery: {
      d1: env.DB,
      accountSecret: () => accountSecret,
      onAccountCodeUsed,
      background: () => {},
    },
  });
}

function recover(a: Auth, body: Record<string, string>, ip = "203.0.113.9") {
  return a.handler(
    new Request(`${BASE}/api/auth${RECOVERY_CODE_PATH}`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    }),
  );
}

async function signIn(a: Auth, email: string, password: string): Promise<number> {
  const response = await a.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  return response.status;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("the recovery code endpoint", () => {
  it("sets the new password, signs the admin out everywhere, and removes the account secret", async () => {
    const secret = await recoveryCodeSecretValue(CODE, Date.now() + 60_000);
    const used = vi.fn();
    const a = auth(secret, used);
    await a.api.createUser({
      body: { email: "owner@example.com", name: "Owner", password: OLD_PASSWORD, role: "admin" },
    });
    expect(await signIn(a, "owner@example.com", OLD_PASSWORD)).toBe(200);
    expect(await createDb(env.DB).select().from(session)).toHaveLength(1);

    const response = await recover(a, {
      email: "owner@example.com",
      code: CODE,
      newPassword: NEW_PASSWORD,
    });
    expect(response.status).toBe(200);
    expect(used).toHaveBeenCalledTimes(1);
    expect(await createDb(env.DB).select().from(session)).toHaveLength(0);
    expect(await signIn(a, "owner@example.com", OLD_PASSWORD)).toBe(401);
    expect(await signIn(a, "owner@example.com", NEW_PASSWORD)).toBe(200);

    const again = await recover(a, {
      email: "owner@example.com",
      code: CODE,
      newPassword: "yet another password",
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: "INVALID_RECOVERY_CODE" });
  });

  it("answers a wrong code with a plain refusal and keeps the password", async () => {
    const a = auth(await recoveryCodeSecretValue(CODE, Date.now() + 60_000));
    await a.api.createUser({
      body: { email: "admin@example.com", name: "Admin", password: OLD_PASSWORD, role: "admin" },
    });
    const response = await recover(a, {
      email: "admin@example.com",
      code: "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ",
      newPassword: NEW_PASSWORD,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_RECOVERY_CODE" });
    expect(await signIn(a, "admin@example.com", OLD_PASSWORD)).toBe(200);
  });

  it("is rate limited per client address", async () => {
    const a = auth(undefined);
    const statuses: number[] = [];
    for (let i = 0; i <= RECOVERY_CODE_RATE_LIMIT.max; i++) {
      const response = await recover(a, {
        email: "nobody@example.com",
        code: CODE,
        newPassword: NEW_PASSWORD,
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([...Array(RECOVERY_CODE_RATE_LIMIT.max).fill(400), 429]);
    // Another address is not held back.
    const other = await recover(
      a,
      { email: "nobody@example.com", code: CODE, newPassword: NEW_PASSWORD },
      "198.51.100.4",
    );
    expect(other.status).toBe(400);
  });

  it("does not exist without the recovery setup", async () => {
    const a = createAuth({ db: createDb(env.DB), secret: SECRET, baseURL: BASE });
    const response = await a.handler(
      new Request(`${BASE}/api/auth${RECOVERY_CODE_PATH}`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(404);
  });
});
