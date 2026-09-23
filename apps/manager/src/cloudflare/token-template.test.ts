import { describe, expect, it } from "vitest";
import {
  accountTokenTemplateUrl,
  appTokenTemplateUrl,
  resolveAppTokenPermissions,
  TOKEN_PERMISSION_GROUPS,
  userTokenTemplateUrl,
} from "./token-template";

function groupsOf(url: string) {
  return JSON.parse(new URL(url).searchParams.get("permissionGroupKeys") ?? "null");
}

describe("token template URLs", () => {
  it("prefill the account token form with every permission group", () => {
    const url = accountTokenTemplateUrl();
    expect(url.startsWith("https://dash.cloudflare.com/?to=/:account/api-tokens&")).toBe(true);
    expect(new URL(url).searchParams.get("name")).toBe("Appflare");
    expect(groupsOf(url)).toEqual(TOKEN_PERMISSION_GROUPS.map(({ key, type }) => ({ key, type })));
  });

  it("prefill the user token form for all accounts and zones", () => {
    const params = new URL(userTokenTemplateUrl()).searchParams;
    expect(
      userTokenTemplateUrl().startsWith("https://dash.cloudflare.com/profile/api-tokens?"),
    ).toBe(true);
    expect(params.get("accountId")).toBe("*");
    expect(params.get("zoneId")).toBe("all");
    expect(groupsOf(userTokenTemplateUrl())).toHaveLength(TOKEN_PERMISSION_GROUPS.length);
  });

  it("asks for edit on resource groups and read on account settings and tail", () => {
    const reads = TOKEN_PERMISSION_GROUPS.filter((g) => g.type === "read").map((g) => g.key);
    expect(reads.sort()).toEqual(["account_settings", "workers_tail"]);
  });
});

describe("app token permissions", () => {
  function keysOf(names: Array<{ name: string; scope?: "account" | "zone" | "user" }>) {
    return resolveAppTokenPermissions(names).map((p) =>
      p.group === null ? null : { key: p.group.key, type: p.group.type },
    );
  }

  it("maps <Scope>.<Group> names to template keys, Edit unless :Read is given", () => {
    expect(
      keysOf([
        { name: "Zone.DNS", scope: "zone" },
        { name: "zone.dns:read" },
        { name: "Account.Workers KV Storage:Edit" },
        { name: "Account.Workers  R2 Storage" },
      ]),
    ).toEqual([
      { key: "dns", type: "edit" },
      { key: "dns", type: "read" },
      { key: "workers_kv_storage", type: "edit" },
      { key: "workers_r2", type: "edit" },
    ]);
  });

  it("qualifies a bare group name with its scope", () => {
    expect(keysOf([{ name: "DNS", scope: "zone" }])).toEqual([{ key: "dns", type: "edit" }]);
  });

  it("maps nothing for unknown names, bare names without a scope, or a contradicting scope", () => {
    expect(
      keysOf([
        { name: "Zone.Email Routing Rules" },
        { name: "DNS" },
        { name: "Zone.DNS", scope: "account" },
        { name: "User.Memberships", scope: "user" },
      ]),
    ).toEqual([null, null, null, null]);
  });

  it("keeps the manifest's name, description, and scope for display", () => {
    const [p] = resolveAppTokenPermissions([
      { name: "Zone.DNS", description: "Edit DNS records", scope: "zone" },
    ]);
    expect(p).toMatchObject({ name: "Zone.DNS", description: "Edit DNS records", scope: "zone" });
    const [bare] = resolveAppTokenPermissions([{ name: "Something" }]);
    expect(bare).toEqual({ name: "Something", description: null, scope: null, group: null });
  });

  it("prefills a user token form named after the app with the mapped groups only", () => {
    const url = appTokenTemplateUrl(
      "UniFi DDNS",
      resolveAppTokenPermissions([
        { name: "Zone.DNS", scope: "zone" },
        { name: "Zone.Email Routing Rules", scope: "zone" },
      ]),
    );
    expect(url?.startsWith("https://dash.cloudflare.com/profile/api-tokens?")).toBe(true);
    const params = new URL(url ?? "").searchParams;
    expect(params.get("name")).toBe("UniFi DDNS");
    expect(params.get("zoneId")).toBe("all");
    expect(groupsOf(url ?? "")).toEqual([{ key: "dns", type: "edit" }]);
  });

  it("lists each key once, Edit winning over Read", () => {
    const url = appTokenTemplateUrl(
      "App",
      resolveAppTokenPermissions([
        { name: "Zone.DNS:Read" },
        { name: "Zone.DNS" },
        { name: "Zone.Zone:Read" },
        { name: "Zone.Zone:Read" },
      ]),
    );
    expect(groupsOf(url ?? "")).toEqual([
      { key: "dns", type: "edit" },
      { key: "zone", type: "read" },
    ]);
  });

  it("gives no link when no permission maps", () => {
    expect(appTokenTemplateUrl("App", resolveAppTokenPermissions([{ name: "Unknown" }]))).toBe(
      null,
    );
    expect(appTokenTemplateUrl("App", [])).toBe(null);
  });
});
