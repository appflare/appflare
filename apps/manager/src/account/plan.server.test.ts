import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readAccountPlan, writeAccountPlan } from "./plan.server";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("the account_plan setting", () => {
  it("is free until an admin records a plan, then keeps the latest", async () => {
    const db = createDb(env.DB);
    expect(await readAccountPlan(db)).toBe("free");
    await writeAccountPlan(db, "paid");
    expect(await readAccountPlan(db)).toBe("paid");
    await writeAccountPlan(db, "free");
    expect(await readAccountPlan(db)).toBe("free");
    expect(
      await env.DB.prepare("SELECT value FROM settings WHERE key = 'account_plan'").first(),
    ).toEqual({ value: "free" });
  });
});
