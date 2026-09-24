import { describe, expect, it } from "vitest";
import { readOnlyNote, userActions } from "./user-actions";

const owner = { id: "o", role: "admin", isOwner: true } as const;
const admin = { id: "a", role: "admin", isOwner: false } as const;
const member = { id: "m", role: "member", isOwner: false } as const;

describe("userActions", () => {
  it("gives the owner role, transfer and delete on an admin's row", () => {
    expect(userActions(true, admin)).toEqual([
      { kind: "role", role: "member" },
      { kind: "transfer" },
      { kind: "delete" },
    ]);
  });

  it("offers no transfer to a member", () => {
    expect(userActions(true, member)).toEqual([
      { kind: "role", role: "admin" },
      { kind: "delete" },
    ]);
  });

  it("offers nothing on the owner's own row", () => {
    expect(userActions(true, owner)).toEqual([]);
  });

  it("offers nothing to anyone but the owner", () => {
    for (const target of [owner, admin, member]) {
      expect(userActions(false, target)).toEqual([]);
    }
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
