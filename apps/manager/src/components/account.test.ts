import { describe, expect, it } from "vitest";
import { ACCOUNT_LINKS, accountInitial, accountName, accountRoleLabel } from "./account";

const ada = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  role: "admin" as const,
  isOwner: false,
};

describe("account menu", () => {
  it("names the user, falling back to their email", () => {
    expect(accountName(ada)).toBe("Ada Lovelace");
    expect(accountName({ ...ada, name: "  " })).toBe("ada@example.com");
  });

  it("shows the first letter of that name on the trigger", () => {
    expect(accountInitial(ada)).toBe("A");
    expect(accountInitial({ ...ada, name: "", email: "zoe@example.com" })).toBe("Z");
    expect(accountInitial({ ...ada, name: "élodie" })).toBe("É");
  });

  it("labels the role, and the owner as such", () => {
    expect(accountRoleLabel(ada)).toBe("Admin");
    expect(accountRoleLabel({ ...ada, role: "member" })).toBe("Member");
    expect(accountRoleLabel({ ...ada, isOwner: true })).toBe("Owner");
    expect(accountRoleLabel({ ...ada, isOwner: false })).toBe("Admin");
  });

  it("links to Users and access and to the passkeys on it", () => {
    expect(ACCOUNT_LINKS).toEqual({
      users: "/settings/users",
      passkeys: "/settings/users#passkeys",
    });
  });
});
