import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../db/client";
import { createAuth } from "./server";
import { ensureAuthStorage, resetAuthStorageForTests } from "./storage.server";

/** Better Auth's per-isolate state (`@better-auth/core`, context/global). */
function betterAuthContext(): Record<string, unknown> | undefined {
  const global = (globalThis as Record<symbol, { context?: Record<string, unknown> }>)[
    Symbol.for("better-auth:global")
  ];
  return global?.context;
}

describe("ensureAuthStorage", () => {
  beforeEach(() => resetAuthStorageForTests());

  it("creates Better Auth's three storages, so no later request awaits its lazy import", async () => {
    const waitUntil = vi.fn();
    await ensureAuthStorage({ waitUntil });
    const context = betterAuthContext();
    expect(context?.endpointContextAsyncStorage).toBeDefined();
    expect(context?.requestStateAsyncStorage).toBeDefined();
    expect(context?.adapterAsyncStorage).toBeDefined();
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("keeps the attempt alive with waitUntil, then does nothing once it succeeded", async () => {
    const waitUntil = vi.fn();
    const create = vi.fn(async () => undefined);
    await ensureAuthStorage({ waitUntil, create });
    await ensureAuthStorage({ waitUntil, create });
    expect(create).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0]?.[0]).toBeInstanceOf(Promise);
  });

  it("does not remember a failed attempt: the next request tries again", async () => {
    const waitUntil = vi.fn();
    await expect(
      ensureAuthStorage({ waitUntil, create: () => Promise.reject(new Error("no async_hooks")) }),
    ).rejects.toThrow("no async_hooks");
    const create = vi.fn(async () => undefined);
    await ensureAuthStorage({ waitUntil, create });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not share an attempt that never settles: a later request succeeds on its own", async () => {
    const waitUntil = vi.fn();
    let settled = false;
    // The first request's attempt hangs, as when the request that started it went away.
    void ensureAuthStorage({ waitUntil, create: () => new Promise(() => {}) }).finally(() => {
      settled = true;
    });
    await ensureAuthStorage({ waitUntil, create: async () => undefined });
    expect(settled).toBe(false);
    // And once one attempt succeeded, nothing is created again.
    const create = vi.fn(async () => undefined);
    await ensureAuthStorage({ waitUntil, create });
    expect(create).not.toHaveBeenCalled();
  });
});

/**
 * Whether `promise` settles while only microtasks run. Nothing that waits on
 * the request (a D1 query, a fetch, a timer) can complete in that time, so a
 * promise that settles here cannot be left pending by a request that ends.
 */
async function settlesWithoutWaiting(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let turn = 0; turn < 1_000 && !settled; turn++) await Promise.resolve();
  return settled;
}

describe("Better Auth's own start-up", () => {
  it("settles without waiting on anything, so a request that ends cannot strand the instance it built", async () => {
    // Built as the manager builds it (server/auth.server.ts), recovery included.
    const auth = createAuth({
      db: createDb(env.DB),
      secret: "test-only-better-auth-secret-0000000000000",
      baseURL: "https://appflare.appflare-dev.workers.dev",
      recovery: {
        d1: env.DB,
        accountSecret: () => undefined,
        onAccountCodeUsed: () => {},
        background: () => {},
      },
    });
    expect(await settlesWithoutWaiting(auth.$context)).toBe(true);
    // The schema check it starts compares the Drizzle schema object; it reads nothing from D1.
    const context = await auth.$context;
    expect(await settlesWithoutWaiting(Promise.resolve(context.checkSchema?.()))).toBe(true);
  });

  it("would notice a start-up that waits on D1", async () => {
    const query = env.DB.prepare("SELECT 1 AS one").first();
    expect(await settlesWithoutWaiting(query)).toBe(false);
    expect(await query).toEqual({ one: 1 });
  });
});
