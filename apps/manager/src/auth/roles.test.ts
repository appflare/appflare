import { describe, expect, it } from "vitest";
import { canResetPassword } from "../components/user-actions";
import { roles } from "./roles";

describe("Better Auth's admin endpoints", () => {
  it("never let an admin set someone's password around the manager's own checks", () => {
    expect(roles.admin.authorize({ user: ["set-password"] }).success).toBe(false);
    expect(roles.member.authorize({ user: ["set-password"] }).success).toBe(false);
    expect(roles.admin.authorize({ user: ["list"] }).success).toBe(true);
  });
});

describe("password resets follow the roles", () => {
  const owner = { id: "o", isAdmin: true, isOwner: true };
  const admin = { id: "a", isAdmin: true, isOwner: false };

  it("reach admins only through the owner, and members through any admin", () => {
    const anotherAdmin = { id: "a2", role: "admin", isOwner: false } as const;
    const member = { id: "m", role: "member", isOwner: false } as const;
    expect(canResetPassword(owner, anotherAdmin)).toBe(true);
    expect(canResetPassword(admin, anotherAdmin)).toBe(false);
    expect(canResetPassword(admin, member)).toBe(true);
  });
});
