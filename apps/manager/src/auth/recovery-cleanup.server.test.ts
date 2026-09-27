import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { RECOVERY_CODE_TTL_MS, recoveryCodeSecretValue } from "@appflare/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { jobs } from "../db/schema";
import { SETTING, writeSettings } from "../db/settings";
import { CLOCK_SKEW_MS, recoverWithCode } from "./recovery.server";
import { cleanUpRecoverySecret, type RecoverySecretCleanupDeps } from "./recovery-cleanup.server";

const NOW = new Date("2026-09-27T12:00:00Z");
const CODE = "ABCDE-FGHJK-LMNPQ-RSTUV";

function fakeApi(split = false) {
  const deleted: string[] = [];
  const api = {
    versions: {
      listDeployments: vi.fn(async () => [
        {
          versions: split
            ? [
                { version_id: "v1", percentage: 50 },
                { version_id: "v2", percentage: 50 },
              ]
            : [{ version_id: "v2", percentage: 100 }],
        },
      ]),
    },
    workers: {
      deleteSecret: vi.fn(async (worker: string, name: string) => {
        deleted.push(`${worker}/${name}`);
        return {};
      }),
    },
  };
  // Only the two methods above are used.
  return { api: api as unknown as Awaited<ReturnType<RecoverySecretCleanupDeps["api"]>>, deleted };
}

function run(
  secret: string | undefined,
  api: ReturnType<typeof fakeApi>["api"],
  extra: Partial<RecoverySecretCleanupDeps> = {},
) {
  return cleanUpRecoverySecret({
    d1: env.DB,
    secret,
    since: NOW.getTime(),
    now: NOW,
    api: async () => api,
    ...extra,
  });
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), { [SETTING.workerName]: "appflare" }, NOW);
});

describe("cleanUpRecoverySecret", () => {
  it("does nothing without a secret, and keeps a code that still works", async () => {
    const fake = fakeApi();
    expect(await run(undefined, fake.api)).toEqual({ outcome: "none" });
    const live = await recoveryCodeSecretValue(CODE, NOW.getTime() + RECOVERY_CODE_TTL_MS);
    expect(await run(live, fake.api)).toEqual({ outcome: "kept" });
    expect(fake.deleted).toEqual([]);
  });

  it("deletes an expired, a malformed, and a used code's secret", async () => {
    const expired = await recoveryCodeSecretValue(CODE, NOW.getTime() - 1);
    let fake = fakeApi();
    expect(await run(expired, fake.api)).toEqual({ outcome: "deleted", reason: "expired" });
    expect(fake.deleted).toEqual(["appflare/RECOVERY_CODE_HASH"]);

    fake = fakeApi();
    expect(await run("v1.garbage", fake.api)).toEqual({ outcome: "deleted", reason: "malformed" });

    const live = await recoveryCodeSecretValue(CODE, NOW.getTime() + RECOVERY_CODE_TTL_MS);
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES ('u', 'U', 'u@example.com', 0, 'admin', 0, 0)",
    ).run();
    await recoverWithCode(
      {
        d1: env.DB,
        now: NOW,
        accountSecret: live,
        passwordLimits: { min: 8, max: 128 },
        setPassword: async () => {},
      },
      { email: "u@example.com", code: CODE, newPassword: "long enough" },
    );
    fake = fakeApi();
    expect(await run(live, fake.api)).toEqual({ outcome: "deleted", reason: "used" });
  });

  it("treats a code written far into the future as expired 35 minutes after its version", async () => {
    const skewed = await recoveryCodeSecretValue(CODE, NOW.getTime() + 24 * 3600_000);
    const fake = fakeApi();
    const later = new Date(NOW.getTime() + RECOVERY_CODE_TTL_MS + CLOCK_SKEW_MS);
    expect(await run(skewed, fake.api, { now: later })).toEqual({
      outcome: "deleted",
      reason: "expired",
    });
  });

  it("waits during a gradual deployment and while Appflare updates itself", async () => {
    const expired = await recoveryCodeSecretValue(CODE, NOW.getTime() - 1);
    const split = fakeApi(true);
    expect(await run(expired, split.api)).toMatchObject({ outcome: "skipped" });
    expect(split.deleted).toEqual([]);

    await createDb(env.DB).insert(jobs).values({
      id: "job-1",
      kind: "self_update",
      status: "running",
      started_at: NOW,
    });
    const fake = fakeApi();
    expect(await run(expired, fake.api)).toMatchObject({ outcome: "skipped" });
    expect(fake.deleted).toEqual([]);
  });
});
