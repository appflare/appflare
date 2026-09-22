import { describe, expect, it } from "vitest";
import { AuthGuardError, type AuthSession, requireRole, requireSession } from "./guards";
import { hasRole } from "./roles";

function sessionWith(role: string | null): AuthSession {
  return {
    user: { id: "u1", email: "a@example.com", name: "A", role },
    session: { id: "s1", expiresAt: new Date("2030-01-01T00:00:00Z") },
  };
}

const none = async () => null;
const as = (role: string | null) => async () => sessionWith(role);

async function statusOf(promise: Promise<unknown>): Promise<number | "ok"> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof AuthGuardError) return error.status;
    throw error;
  }
}

describe("requireSession", () => {
  it("returns the session when there is one", async () => {
    await expect(requireSession(as("member"))).resolves.toEqual(sessionWith("member"));
  });

  it("rejects with 401 without a session", async () => {
    expect(await statusOf(requireSession(none))).toBe(401);
  });
});

describe("requireRole", () => {
  it("lets admins do admin things", async () => {
    expect(await statusOf(requireRole("admin", as("admin")))).toBe("ok");
  });

  it("rejects members with 403 for admin things", async () => {
    expect(await statusOf(requireRole("admin", as("member")))).toBe(403);
  });

  it("rejects users without a role with 403", async () => {
    expect(await statusOf(requireRole("member", as(null)))).toBe(403);
    expect(await statusOf(requireRole("admin", as("")))).toBe(403);
  });

  it("treats admin as including member", async () => {
    expect(await statusOf(requireRole("member", as("admin")))).toBe("ok");
    expect(await statusOf(requireRole("member", as("member")))).toBe("ok");
  });

  it("checks the session before the role", async () => {
    expect(await statusOf(requireRole("admin", none))).toBe(401);
  });
});

describe("hasRole", () => {
  it("understands Better Auth's comma-separated roles", () => {
    expect(hasRole("member, admin", "admin")).toBe(true);
    expect(hasRole("member,other", "admin")).toBe(false);
    expect(hasRole("user", "member")).toBe(false);
    expect(hasRole(undefined, "member")).toBe(false);
  });
});
