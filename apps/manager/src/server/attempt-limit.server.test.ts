import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { takeAttempt } from "./attempt-limit.server";

const T = 1_790_000_000_000;
const LIMIT = { max: 2, windowMs: 60_000 };

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("the attempt limit before sign-in", () => {
  it("counts each door and each address on its own, and starts again after the window", async () => {
    const take = (scope: string, client: string, at: number) =>
      takeAttempt(env.DB, scope, client, at, LIMIT);
    expect(await take("handoff", "203.0.113.7", T)).toBe(true);
    expect(await take("handoff", "203.0.113.7", T + 1)).toBe(true);
    expect(await take("handoff", "203.0.113.7", T + 2)).toBe(false);
    // Another door, another address: their own counts.
    expect(await take("setup-token", "203.0.113.7", T + 3)).toBe(true);
    expect(await take("handoff", "198.51.100.2", T + 4)).toBe(true);
    // A new window.
    expect(await take("handoff", "203.0.113.7", T + LIMIT.windowMs)).toBe(true);
  });

  it("stores no address", async () => {
    await takeAttempt(env.DB, "handoff", "203.0.113.7", new Date(T), LIMIT);
    const { results } = await env.DB.prepare("SELECT id, key FROM rate_limit").all();
    expect(JSON.stringify(results)).not.toContain("203.0.113.7");
    expect(JSON.stringify(results)).toContain("appflare:handoff:");
  });
});
