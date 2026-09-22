import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { fakeCloudflare } from "../test/fake-cloudflare";
import { CfTokenNotConfiguredError, getCfClient } from "./client.server";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("getCfClient", () => {
  it("throws a typed error without CF_API_TOKEN", async () => {
    await expect(getCfClient({ DB: env.DB })).rejects.toBeInstanceOf(CfTokenNotConfiguredError);
  });

  it("throws a typed error before the account id is recorded", async () => {
    const error = await getCfClient({ DB: env.DB, CF_API_TOKEN: "t" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CfTokenNotConfiguredError);
    expect((error as CfTokenNotConfiguredError).missing).toBe("account");
  });

  it("builds a client for the recorded account", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.accountId]: "acc-1" });
    const api = fakeCloudflare({ "GET /accounts/acc-1/workers/scripts": { result: [] } });
    const client = await getCfClient({ DB: env.DB, CF_API_TOKEN: "t" }, { fetch: api.fetch });
    expect(client.accountId).toBe("acc-1");
    await client.workers.listScripts();
    expect(api.calls[0]?.authorization).toBe("Bearer t");
  });
});
