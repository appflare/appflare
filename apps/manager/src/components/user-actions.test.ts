import { describe, expect, it } from "vitest";
import { canResetPassword, readOnlyNote, userActions } from "./user-actions";

const owner = { id: "o", role: "admin", isOwner: true } as const;
const admin = { id: "a", role: "admin", isOwner: false } as const;
const admin2 = { id: "a2", role: "admin", isOwner: false } as const;
const member = { id: "m", role: "member", isOwner: false } as const;

const asOwner = { id: "o", isAdmin: true, isOwner: true };
const asAdmin = { id: "a", isAdmin: true, isOwner: false };
const asMember = { id: "m", isAdmin: false, isOwner: false };

describe("userActions", () => {
  it("gives the owner reset, role, transfer and delete on an admin's row", () => {
    expect(userActions(asOwner, admin)).toEqual([
      { kind: "reset" },
      { kind: "role", role: "member" },
      { kind: "transfer" },
      { kind: "delete" },
    ]);
  });

  it("offers no transfer to a member", () => {
    expect(userActions(asOwner, member)).toEqual([
      { kind: "reset" },
      { kind: "role", role: "admin" },
      { kind: "delete" },
    ]);
  });

  it("offers nothing on the owner's own row", () => {
    expect(userActions(asOwner, owner)).toEqual([]);
    expect(userActions(asAdmin, owner)).toEqual([]);
  });

  it("gives an admin only a password reset, and only on members' rows", () => {
    expect(userActions(asAdmin, member)).toEqual([{ kind: "reset" }]);
    expect(userActions(asAdmin, admin2)).toEqual([]);
    expect(userActions(asAdmin, admin)).toEqual([]);
  });

  it("offers members nothing", () => {
    for (const target of [owner, admin, member]) {
      expect(userActions(asMember, target)).toEqual([]);
    }
  });
});

describe("canResetPassword", () => {
  it("never lets anyone reset the owner's password or their own", () => {
    expect(canResetPassword(asAdmin, owner)).toBe(false);
    expect(canResetPassword(asOwner, owner)).toBe(false);
    expect(canResetPassword(asAdmin, admin)).toBe(false);
    expect(canResetPassword(asMember, member)).toBe(false);
  });

  it("lets only the owner reset an admin; admins reset members", () => {
    expect(canResetPassword(asOwner, admin2)).toBe(true);
    expect(canResetPassword(asOwner, member)).toBe(true);
    expect(canResetPassword(asAdmin, admin2)).toBe(false);
    expect(canResetPassword(asAdmin, member)).toBe(true);
  });
});

describe("readOnlyNote", () => {
  it("names the owner when known", () => {
    expect(readOnlyNote({ name: "Ada", email: "ada@example.com" })).toBe(
      "Only the owner, Ada (ada@example.com), can change roles or delete users.",
    );
    expect(readOnlyNote(undefined)).toBe("Only the owner can change roles or delete users.");
  });
});
