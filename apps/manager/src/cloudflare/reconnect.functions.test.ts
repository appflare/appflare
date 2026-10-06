import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The server function an administrator's "Continue to Cloudflare" calls:
 * only an administrator starts a sign-in, and it returns to the address the
 * request came to. TanStack Start's server function builder is replaced by
 * one that returns the handler, so it can be called here.
 */

const requireRole = vi.fn();
const startReconnect = vi.fn();

vi.mock("@tanstack/react-start", () => {
  const chain = {
    validator: () => chain,
    inputValidator: () => chain,
    handler: (fn: () => unknown) => fn,
  };
  return { createServerFn: () => chain };
});
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("https://appflare.example.com/_serverFn/abc", { method: "POST" }),
}));
vi.mock("../server/auth.server", () => ({ requireRole }));
vi.mock("./reconnect.server", async (original) => ({
  ...(await original<typeof import("./reconnect.server")>()),
  startReconnect,
}));

const { startCloudflareReconnect } = await import("./reconnect.functions");
const call = startCloudflareReconnect as unknown as () => Promise<unknown>;

beforeEach(() => {
  requireRole.mockReset();
  startReconnect.mockReset();
});

describe("startCloudflareReconnect", () => {
  it("refuses a member before anything is started", async () => {
    requireRole.mockRejectedValue(new Error("Only administrators can do this."));
    await expect(call()).rejects.toThrow("Only administrators can do this.");
    expect(requireRole).toHaveBeenCalledWith("admin");
    expect(startReconnect).not.toHaveBeenCalled();
  });

  it("starts for an administrator, returning to the address the request came to", async () => {
    requireRole.mockResolvedValue({ user: { id: "user-admin" }, session: { id: "s" } });
    startReconnect.mockResolvedValue({ url: "https://dash.cloudflare.com/oauth2/auth?x" });
    await call();
    expect(startReconnect).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-admin", origin: "https://appflare.example.com" }),
    );
  });
});
