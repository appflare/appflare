import { beforeEach, describe, expect, it, vi } from "vitest";
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
