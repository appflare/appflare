import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../../db/client";
import { createMigrator } from "../../db/migrate";
import { migrations } from "../../db/migrations/index";
import { settings } from "../../db/schema";
import { countD1 } from "./count-d1";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("countD1", () => {
  it("counts each statement run and each batch once, through Drizzle too", async () => {
    let calls = 0;
    const db = countD1(env.DB, () => {
      calls += 1;
    });
    await db.prepare("SELECT 1").first();
    await db.prepare("SELECT ?1").bind(2).all();
    expect(calls).toBe(2);
    await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2")]);
    expect(calls).toBe(3);
    const orm = createDb(db);
    await orm.insert(settings).values({ key: "k", value: "v", updated_at: new Date(1) });
    await orm.select().from(settings);
    expect(calls).toBe(5);
    await orm.batch([orm.select().from(settings), orm.select().from(settings)]);
    expect(calls).toBe(6);
  });
});
