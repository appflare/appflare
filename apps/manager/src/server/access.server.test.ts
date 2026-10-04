import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { syncAppAccessAfterUserChange } from "./access.server";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("syncAppAccessAfterUserChange", () => {
  it("is off while no app was ever protected", async () => {
    expect(await syncAppAccessAfterUserChange()).toBe("off");
  });

  it("reports a failure instead of throwing, so the user change itself stands", async () => {
    // A policy is recorded, but this test Worker has no Cloudflare token to update it with.
    await writeSettings(createDb(env.DB), { [SETTING.appAccessUsersPolicyId]: "pol-1" });
    expect(await syncAppAccessAfterUserChange()).toBe("failed");
  });
});
