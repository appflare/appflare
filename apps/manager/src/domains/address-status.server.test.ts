import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { readAddressStatus } from "./address-status.server";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("readAddressStatus", () => {
  it("says whether a domain is pending, then where Appflare moved", async () => {
    expect(await readAddressStatus(env.DB)).toEqual({ hostname: null, pending: false });
    await writeSettings(createDb(env.DB), {
      [SETTING.managerPendingHostname]: "appflare.example.com",
    });
    expect(await readAddressStatus(env.DB)).toEqual({ hostname: null, pending: true });
    await writeSettings(createDb(env.DB), { [SETTING.managerHostname]: "appflare.example.com" });
    expect(await readAddressStatus(env.DB)).toEqual({
      hostname: "appflare.example.com",
      pending: false,
    });
  });
});
