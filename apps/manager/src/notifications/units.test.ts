import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { selfNotificationUnits } from "./units";

/**
 * The notification units over the real `SELF` binding (the test Worker's
 * `JobUnits`). Only calls that make no outbound request are made here: the
 * callee uses the global `fetch`, which a test cannot answer. The work
 * itself is covered in place by the delivery, cron and job-end tests.
 */

const self = selfNotificationUnits(env);

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("notification units over SELF", () => {
  it("deliver nothing when nothing is due, as plain data", async () => {
    expect(await self?.deliverNotifications({})).toEqual({
      ok: true,
      value: { claimed: 0, sent: 0, retrying: 0, failed: 0 },
    });
  });

  it("check no installs when given none", async () => {
    expect(await self?.checkInstallsHealth({ installIds: [] })).toEqual({
      ok: true,
      value: { checked: 0, unhealthy: 0, unhealthyIds: [] },
    });
  });

  it("check no external domains when there are none, without asking Cloudflare", async () => {
    expect(await self?.checkExternalDomains({})).toEqual({
      ok: true,
      value: { checked: 0, zones: 0, unreadZones: 0, activated: 0, failed: 0, queued: 0 },
    });
  });

  it("run each part of the Access upkeep as plain lines, without asking Cloudflare when nothing is protected", async () => {
    for (const part of [
      "refreshAccessRevisions",
      "renewAccessTokens",
      "resyncAccessApps",
    ] as const) {
      expect(await self?.[part]({})).toEqual({ ok: true, value: { lines: [] } });
    }
  });

  it("validate their input on arrival", async () => {
    expect(await self?.deliverNotifications({ eventId: 5 })).toMatchObject({ ok: false });
    expect(
      await self?.checkInstallsHealth({
        installIds: Array.from({ length: 6 }, (_, i) => `i${i}`),
      }),
    ).toMatchObject({ ok: false });
  });
});
