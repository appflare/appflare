import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { markSeen, readSeenVersion, seenKey } from "./seen.server";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("the release notes a user has seen", () => {
  it("is nothing until they look, then only moves forward", async () => {
    const db = createDb(env.DB);
    expect(await readSeenVersion(db, "user-1")).toBeNull();
    expect(await markSeen(db, "user-1", "0.4.0")).toBe("0.4.0");
    expect(await markSeen(db, "user-1", "0.3.1")).toBe("0.4.0");
    expect(await readSeenVersion(db, "user-1")).toBe("0.4.0");
    expect(await markSeen(db, "user-1", "0.10.0")).toBe("0.10.0");
    expect(await readSeenVersion(db, "user-1")).toBe("0.10.0");
  });

  it("is kept per user", async () => {
    const db = createDb(env.DB);
    await markSeen(db, "user-1", "0.4.0");
    expect(await readSeenVersion(db, "user-2")).toBeNull();
    expect(
      await env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
        .bind(seenKey("user-1"))
        .first(),
    ).toEqual({ value: "0.4.0" });
  });
});
