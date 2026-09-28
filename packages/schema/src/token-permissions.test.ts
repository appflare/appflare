import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  APP_TOKEN_PERMISSION_GROUPS,
  appTokenPermissionGroup,
  mergeTokenPermissions,
  type TokenPermission,
  tokenPermissionGroupNames,
  tokenPermissionName,
  tokenPermissionSchema,
  tokenPermissionsSchema,
} from "./token-permissions";

const dns: TokenPermission = {
  group: "DNS",
  scope: "zone",
  access: "edit",
  reason: "Updates the record the router points at.",
};

describe("APP_TOKEN_PERMISSION_GROUPS", () => {
  it("lists each scope and group once, each with a template key", () => {
    const keys = APP_TOKEN_PERMISSION_GROUPS.map((g) => `${g.scope}:${g.group}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const g of APP_TOKEN_PERMISSION_GROUPS) expect(g.templateKey).toMatch(/^[a-z0-9_]+$/);
  });

  it("tells the account and zone Logs groups apart", () => {
    expect(appTokenPermissionGroup("zone", "Logs")?.templateKey).toBe("logs");
    expect(appTokenPermissionGroup("account", "Logs")?.templateKey).toBe("account_logs");
    expect(appTokenPermissionGroup("account", "Hyperdrive")?.templateKey).toBe("query_cache");
    expect(appTokenPermissionGroup("zone", "Workers Scripts")).toBeNull();
    expect(tokenPermissionGroupNames("zone")).toContain("Email Routing Rules");
  });
});

describe("tokenPermissionSchema", () => {
  it("takes a group of its scope, an access level and a reason", () => {
    expect(tokenPermissionSchema.parse(dns)).toEqual(dns);
    expect(
      tokenPermissionSchema.safeParse({
        ...dns,
        group: "Account Analytics",
        scope: "account",
        access: "read",
      }).success,
    ).toBe(true);
  });

  it("refuses an unknown group, a group of the other scope, and a missing reason or access", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...dns, group: "Zone.DNS:Edit" }, "group"],
      [{ ...dns, scope: "account" }, "is not a account permission group"],
      [{ ...dns, scope: "user" }, "scope"],
      [{ ...dns, access: "write" }, "access"],
      [{ ...dns, reason: " " }, "reason"],
      [{ group: "DNS", scope: "zone", reason: "x" }, "access"],
    ];
    for (const [value, why] of cases) {
      const result = tokenPermissionSchema.safeParse(value);
      expect(result.success, why).toBe(false);
      expect(JSON.stringify(result.error?.issues), why).toContain(why);
    }
  });

  it("states the scope and group pairs in the JSON Schema", () => {
    const json = z.toJSONSchema(tokenPermissionSchema) as { anyOf?: unknown[] };
    expect(json.anyOf).toContainEqual({
      properties: { scope: { const: "zone" }, group: { enum: tokenPermissionGroupNames("zone") } },
    });
  });
});

describe("tokenPermissionsSchema", () => {
  it("refuses a scope and group listed twice", () => {
    const result = tokenPermissionsSchema.safeParse([dns, { ...dns, access: "read" }]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([1, "group"]);
  });
});

describe("helpers", () => {
  it("word a permission as the dashboard does", () => {
    expect(tokenPermissionName(dns)).toBe("Zone: DNS: Edit");
  });

  it("merge a list, keeping the stronger access and the first reason", () => {
    const merged = mergeTokenPermissions([
      { ...dns, access: "read" },
      { ...dns, reason: "Another reason." },
      { group: "D1", scope: "account", access: "read", reason: "Reads the database." },
    ]);
    expect(merged).toEqual([
      { ...dns, access: "edit" },
      { group: "D1", scope: "account", access: "read", reason: "Reads the database." },
    ]);
  });
});
