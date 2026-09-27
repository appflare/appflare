import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { RECOVERY_CODE_TTL_MS, recoveryCodeSecretValue } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { user } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { transferOwnership } from "../server/users.server";
import {
  CLOCK_SKEW_MS,
  issueRecoveryCode,
  parseStoredRecovery,
  RECOVERY_MESSAGES,
  type RecoverDeps,
  RecoveryError,
  recoverWithCode,
} from "./recovery.server";

const NOW = new Date("2026-09-27T12:00:00Z");
const CODE = "ABCDE-FGHJK-LMNPQ-RSTUV";
const OTHER_CODE = "ZZZZZ-FGHJK-LMNPQ-RSTUV";
const NEW_PASSWORD = "a new long password";

async function seedUser(id: string, role: "admin" | "member", isOwner = false) {
  await createDb(env.DB)
    .insert(user)
    .values({
      id,
      name: id,
      email: `${id}@example.com`,
      role,
      isOwner,
      createdAt: NOW,
      updatedAt: NOW,
    });
}

/** Deps with a recorded `setPassword` and the account secret given. */
function deps(accountSecret: string | undefined, now = NOW) {
  const set: string[] = [];
  const d: RecoverDeps = {
    d1: env.DB,
    now,
    accountSecret,
    passwordLimits: { min: 8, max: 128 },
    async setPassword(userId) {
      set.push(userId);
    },
  };
  return { deps: d, set };
}

async function refused(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof RecoveryError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

const secretFor = (
  code: string,
  expiresAt = NOW.getTime() + RECOVERY_CODE_TTL_MS,
  email?: string,
) => recoveryCodeSecretValue(code, expiresAt, email);

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedUser("owner", "admin", true);
  await seedUser("admin", "admin");
  await seedUser("member", "member");
});

describe("a recovery code from the Cloudflare account", () => {
  it("resets an admin's password once, records it, and refuses the same code again", async () => {
    const secret = await secretFor(CODE);
    const first = deps(secret);
    await expect(
      recoverWithCode(first.deps, {
        email: "OWNER@example.com",
        code: CODE.toLowerCase(),
        newPassword: NEW_PASSWORD,
      }),
    ).resolves.toEqual({ userId: "owner", method: "account_code" });
    expect(first.set).toEqual(["owner"]);

    const stored = await readSettings(createDb(env.DB), [SETTING.lastPasswordRecovery]);
    expect(parseStoredRecovery(stored.last_password_recovery)).toEqual({
      at: NOW.toISOString(),
      method: "account_code",
      userId: "owner",
    });

    // The Worker secret may still be there until the version without it serves.
    const again = deps(secret);
    expect(
      await refused(
        recoverWithCode(again.deps, {
          email: "admin@example.com",
          code: CODE,
          newPassword: NEW_PASSWORD,
        }),
      ),
    ).toBe("INVALID_RECOVERY_CODE");
    expect(again.set).toEqual([]);
  });

  it("lets only one of two simultaneous uses through", async () => {
    const secret = await secretFor(CODE);
    const a = deps(secret);
    const b = deps(secret);
    const input = { email: "admin@example.com", code: CODE, newPassword: NEW_PASSWORD };
    const results = await Promise.allSettled([
      recoverWithCode(a.deps, input),
      recoverWithCode(b.deps, input),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect([...a.set, ...b.set]).toEqual(["admin"]);
  });

  it("stops working when it expires", async () => {
    const secret = await secretFor(CODE, NOW.getTime() + 1000);
    const later = deps(secret, new Date(NOW.getTime() + 1000));
    expect(
      await refused(
        recoverWithCode(later.deps, {
          email: "owner@example.com",
          code: CODE,
          newPassword: NEW_PASSWORD,
        }),
      ),
    ).toBe("INVALID_RECOVERY_CODE");
    expect(later.set).toEqual([]);
  });

  it("gives the same answer to a wrong code whether or not the email belongs to anyone", async () => {
    const { deps: d, set } = deps(await secretFor(CODE));
    for (const email of ["owner@example.com", "nobody@example.com"]) {
      const error = await recoverWithCode(d, {
        email,
        code: OTHER_CODE,
        newPassword: NEW_PASSWORD,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RecoveryError);
      expect((error as RecoveryError).message).toBe(RECOVERY_MESSAGES.invalid);
    }
    expect(
      await refused(
        recoverWithCode(d, {
          email: "owner@example.com",
          code: "not a code",
          newPassword: NEW_PASSWORD,
        }),
      ),
    ).toBe("INVALID_RECOVERY_CODE");
    expect(set).toEqual([]);
  });

  it("does nothing without a secret, or with a malformed one", async () => {
    for (const secret of [undefined, "", "v1.oops"]) {
      const { deps: d } = deps(secret);
      expect(
        await refused(
          recoverWithCode(d, { email: "owner@example.com", code: CODE, newPassword: NEW_PASSWORD }),
        ),
      ).toBe("INVALID_RECOVERY_CODE");
    }
  });

  it("resets admins only, and keeps the code for a corrected email", async () => {
    const secret = await secretFor(CODE);
    const { deps: d, set } = deps(secret);
    for (const email of ["member@example.com", "nobody@example.com"]) {
      expect(
        await refused(recoverWithCode(d, { email, code: CODE, newPassword: NEW_PASSWORD })),
      ).toBe("NO_ADMIN_WITH_EMAIL");
    }
    await recoverWithCode(d, { email: "admin@example.com", code: CODE, newPassword: NEW_PASSWORD });
    expect(set).toEqual(["admin"]);
  });

  it("checks the new password's length before using the code", async () => {
    const secret = await secretFor(CODE);
    const { deps: d, set } = deps(secret);
    expect(
      await refused(
        recoverWithCode(d, { email: "owner@example.com", code: CODE, newPassword: "short" }),
      ),
    ).toBe("PASSWORD_TOO_SHORT");
    await recoverWithCode(d, { email: "owner@example.com", code: CODE, newPassword: NEW_PASSWORD });
    expect(set).toEqual(["owner"]);
  });

  it("accepts a new code after the last one was used", async () => {
    const first = deps(await secretFor(CODE));
    await recoverWithCode(first.deps, {
      email: "owner@example.com",
      code: CODE,
      newPassword: NEW_PASSWORD,
    });
    const second = deps(await secretFor(OTHER_CODE));
    await recoverWithCode(second.deps, {
      email: "owner@example.com",
      code: OTHER_CODE,
      newPassword: NEW_PASSWORD,
    });
    expect(second.set).toEqual(["owner"]);
  });
});

describe("the account code's limits", () => {
  it("works only with the email it was bound to", async () => {
    const secret = await secretFor(CODE, undefined, "Admin@Example.com");
    const { deps: d, set } = deps(secret);
    expect(
      await refused(
        recoverWithCode(d, { email: "owner@example.com", code: CODE, newPassword: NEW_PASSWORD }),
      ),
    ).toBe("INVALID_RECOVERY_CODE");
    await recoverWithCode(d, { email: "admin@example.com", code: CODE, newPassword: NEW_PASSWORD });
    expect(set).toEqual(["admin"]);
  });

  it("stops 35 minutes after its version was created, whatever expiry the installer wrote", async () => {
    const secret = await secretFor(CODE, NOW.getTime() + 24 * 3600_000);
    const since = NOW.getTime();
    const input = { email: "owner@example.com", code: CODE, newPassword: NEW_PASSWORD };
    const late = deps(secret, new Date(since + RECOVERY_CODE_TTL_MS + CLOCK_SKEW_MS));
    expect(await refused(recoverWithCode({ ...late.deps, accountSecretSince: since }, input))).toBe(
      "INVALID_RECOVERY_CODE",
    );
    const inTime = deps(secret, new Date(since + RECOVERY_CODE_TTL_MS));
    await recoverWithCode({ ...inTime.deps, accountSecretSince: since }, input);
    expect(inTime.set).toEqual(["owner"]);
  });
});

describe("a recovery code an admin issued", () => {
  it("resets that user's password once, members included", async () => {
    const { code } = await issueRecoveryCode(env.DB, "member", NOW);
    const { deps: d, set } = deps(undefined);
    await expect(
      recoverWithCode(d, { email: "member@example.com", code, newPassword: NEW_PASSWORD }),
    ).resolves.toEqual({ userId: "member", method: "issued_code" });
    expect(
      await refused(
        recoverWithCode(d, { email: "member@example.com", code, newPassword: NEW_PASSWORD }),
      ),
    ).toBe("INVALID_RECOVERY_CODE");
    expect(set).toEqual(["member"]);
  });

  it("works only with that user's email", async () => {
    const { code } = await issueRecoveryCode(env.DB, "member", NOW);
    const { deps: d, set } = deps(undefined);
    expect(
      await refused(
        recoverWithCode(d, { email: "admin@example.com", code, newPassword: NEW_PASSWORD }),
      ),
    ).toBe("INVALID_RECOVERY_CODE");
    expect(set).toEqual([]);
  });

  it("expires after 30 minutes", async () => {
    const { code, expiresAt } = await issueRecoveryCode(env.DB, "admin", NOW);
    expect(expiresAt.getTime()).toBe(NOW.getTime() + RECOVERY_CODE_TTL_MS);
    const { deps: d } = deps(undefined, expiresAt);
    expect(
      await refused(
        recoverWithCode(d, { email: "admin@example.com", code, newPassword: NEW_PASSWORD }),
      ),
    ).toBe("INVALID_RECOVERY_CODE");
  });

  it("is replaced by a newer one", async () => {
    const old = await issueRecoveryCode(env.DB, "admin", NOW);
    const current = await issueRecoveryCode(env.DB, "admin", NOW);
    const { deps: d, set } = deps(undefined);
    expect(
      await refused(
        recoverWithCode(d, {
          email: "admin@example.com",
          code: old.code,
          newPassword: NEW_PASSWORD,
        }),
      ),
    ).toBe("INVALID_RECOVERY_CODE");
    await recoverWithCode(d, {
      email: "admin@example.com",
      code: current.code,
      newPassword: NEW_PASSWORD,
    });
    expect(set).toEqual(["admin"]);
  });

  it("never resets the owner, even when its user became the owner later", async () => {
    const { code } = await issueRecoveryCode(env.DB, "owner", NOW);
    const { deps: d, set } = deps(undefined);
    expect(
      await refused(
        recoverWithCode(d, { email: "owner@example.com", code, newPassword: NEW_PASSWORD }),
      ),
    ).toBe("INVALID_RECOVERY_CODE");
    expect(set).toEqual([]);
  });

  it("is withdrawn when its user becomes the owner", async () => {
    const { code } = await issueRecoveryCode(env.DB, "admin", NOW);
    await transferOwnership(createDb(env.DB), "owner", { userId: "admin" });
    const { deps: d, set } = deps(undefined);
    expect(
      await refused(
        recoverWithCode(d, { email: "admin@example.com", code, newPassword: NEW_PASSWORD }),
      ),
    ).toBe("INVALID_RECOVERY_CODE");
    expect(set).toEqual([]);
    const rows = await env.DB.prepare("SELECT id FROM verification").all();
    expect(rows.results).toEqual([]);
  });

  it("stores only a hash of the code", async () => {
    const { code } = await issueRecoveryCode(env.DB, "admin", NOW);
    const rows = await env.DB.prepare("SELECT value FROM verification").all<{ value: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.value).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.results[0]?.value).not.toContain(code.replace(/-/g, ""));
  });
});
