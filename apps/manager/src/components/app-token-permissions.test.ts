import { describe, expect, it } from "vitest";
import { resolveAppTokenPermissions } from "../cloudflare/token-template";
import { permissionTitle } from "./app-token-permissions";

const reason = "Needed.";

describe("permissionTitle", () => {
  it("words each permission at the level the token form selects", () => {
    const resolved = resolveAppTokenPermissions([
      { scope: "zone", group: "DNS", access: "edit", reason },
      { scope: "account", group: "D1", access: "read", reason },
      { scope: "zone", group: "Cache Purge", access: "edit", reason },
    ]);
    expect(resolved.map(permissionTitle)).toEqual([
      "Zone: DNS · Edit",
      "Account: D1 · Read",
      "Zone: Cache Purge · Purge",
    ]);
  });

  it("falls back to the access asked for when the group has no template key", () => {
    const [unknown] = resolveAppTokenPermissions([
      { scope: "account", group: "Workers Quantum Storage", access: "read", reason },
    ]);
    expect(unknown?.group).toBeNull();
    expect(permissionTitle(unknown as NonNullable<typeof unknown>)).toBe(
      "Account: Workers Quantum Storage · Read",
    );
  });
});
