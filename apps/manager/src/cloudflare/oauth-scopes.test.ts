import { MANAGER_OAUTH_SCOPE_BY_GROUP, MANAGER_OAUTH_SCOPES } from "@appflare/cf-api/oauth";
import { describe, expect, it } from "vitest";
import { TOKEN_PERMISSION_GROUPS } from "./token-template";

/**
 * A browser install and an OAuth reconnect ask for one OAuth scope per
 * permission group of Appflare's API token. A group added to the token
 * without a scope decision would be missing from every OAuth connection, so
 * these fail until `MANAGER_OAUTH_SCOPE_BY_GROUP` in @appflare/cf-api maps
 * it to a scope from Cloudflare's catalog (`GET /oauth/scopes`) or to `null`
 * with a comment saying why it has none.
 */

type GroupKey = (typeof TOKEN_PERMISSION_GROUPS)[number]["key"];

// Fails to typecheck when a group has no entry, before any test runs.
const decisions: Record<GroupKey, string | null> = MANAGER_OAUTH_SCOPE_BY_GROUP;

/** Groups OAuth cannot cover, decided one by one. */
const SCOPE_LESS: readonly GroupKey[] = ["billing"];

describe("OAuth scope for each permission group", () => {
  it.each(TOKEN_PERMISSION_GROUPS.map((g) => [g.key, g] as const))(
    "%s has a scope decision",
    (key) => {
      expect(Object.hasOwn(MANAGER_OAUTH_SCOPE_BY_GROUP, key)).toBe(true);
    },
  );

  it("decides only groups the token has", () => {
    const keys = new Set<string>(TOKEN_PERMISSION_GROUPS.map((g) => g.key));
    expect(Object.keys(MANAGER_OAUTH_SCOPE_BY_GROUP).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("maps every group but the ones decided scope-less, at the group's level", () => {
    for (const group of TOKEN_PERMISSION_GROUPS) {
      const scope = decisions[group.key];
      if (SCOPE_LESS.includes(group.key)) {
        expect(scope, group.key).toBeNull();
        continue;
      }
      expect(scope, group.key).toEqual(expect.any(String));
      const level = group.type === "read" ? ".read" : ".write";
      expect(scope?.endsWith(level), `${group.key} -> ${scope}`).toBe(true);
    }
  });

  it("requests every mapped scope", () => {
    for (const group of TOKEN_PERMISSION_GROUPS) {
      const scope = decisions[group.key];
      if (scope !== null) expect(MANAGER_OAUTH_SCOPES, group.key).toContain(scope);
    }
  });
});
