import { APP_TOKEN_PERMISSION_GROUPS, type TokenPermission } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import {
  ACCESS_FEATURE,
  accountTokenTemplateUrl,
  appTokenTemplateUrl,
  CUSTOM_DOMAINS_FEATURE,
  DATABASE_ELSEWHERE_FEATURE,
  EMAIL_ROUTING_FEATURE,
  EXTERNAL_DOMAINS_FEATURE,
  optionalGroupsByFeature,
  PIPELINES_FEATURE,
  PLAN_DETECTION_FEATURE,
  permissionName,
  r2ApiTokensUrl,
  resolveAppTokenPermissions,
  SANDBOX_BUILDS_FEATURE,
  splitPermissionGroups,
  TOKEN_PERMISSION_GROUPS,
  UNMAPPED_PERMISSION_REASON,
  userTokenTemplateUrl,
} from "./token-template";

function groupsOf(url: string) {
  return JSON.parse(new URL(url).searchParams.get("permissionGroupKeys") ?? "null");
}

describe("token template URLs", () => {
  it("prefill the account token form with every permission group that has a template key", () => {
    const url = accountTokenTemplateUrl();
    // Before the first token is saved the account is not known: the dashboard asks.
    expect(url.startsWith("https://dash.cloudflare.com/?to=/:account/api-tokens&")).toBe(true);
    expect(
      accountTokenTemplateUrl("acc1").startsWith(
        "https://dash.cloudflare.com/?to=/acc1/api-tokens&",
      ),
    ).toBe(true);
    expect(r2ApiTokensUrl("acc1")).toBe("https://dash.cloudflare.com/?to=/acc1/r2/api-tokens");
    expect(new URL(url).searchParams.get("name")).toBe("Appflare");
    expect(groupsOf(url)).toEqual(
      TOKEN_PERMISSION_GROUPS.filter((g) => !("manual" in g)).map(({ key, type }) => ({
        key,
        type,
      })),
    );
  });

  it("prefill the user token form for all accounts and zones", () => {
    const params = new URL(userTokenTemplateUrl()).searchParams;
    expect(
      userTokenTemplateUrl().startsWith("https://dash.cloudflare.com/profile/api-tokens?"),
    ).toBe(true);
    expect(params.get("accountId")).toBe("*");
    expect(
      new URL(userTokenTemplateUrl(undefined, "App", "acc1")).searchParams.get("accountId"),
    ).toBe("acc1");
    expect(params.get("zoneId")).toBe("all");
    expect(groupsOf(userTokenTemplateUrl())).toHaveLength(
      TOKEN_PERMISSION_GROUPS.filter((g) => !("manual" in g)).length,
    );
  });

  it("asks for edit on resource groups and read on account settings, billing, tail, Access organizations, and zones", () => {
    const reads = TOKEN_PERMISSION_GROUPS.filter((g) => g.type === "read").map((g) => g.key);
    expect(reads.sort()).toEqual([
      "access_acct",
      "account_settings",
      "billing",
      "email_routing_address",
      "workers_tail",
      "zone",
    ]);
  });

  it("includes the Access groups, marked as used only by the Access setting", () => {
    const { required, optional } = splitPermissionGroups();
    const access = optional.filter((g) => g.onlyFor === ACCESS_FEATURE);
    expect(access.map(({ key, type }) => ({ key, type }))).toEqual([
      { key: "access", type: "edit" },
      { key: "access_acct", type: "read" },
    ]);
    expect(required.some((g) => g.key.startsWith("access"))).toBe(false);
    expect(groupsOf(accountTokenTemplateUrl())).toContainEqual({ key: "access", type: "edit" });
    expect(groupsOf(accountTokenTemplateUrl())).toContainEqual({
      key: "access_acct",
      type: "read",
    });
    expect(access.map(permissionName)).toEqual([
      "Access: Apps and Policies: Edit",
      "Access: Organizations, Identity Providers, and Groups: Read",
    ]);
  });

  it("includes the custom domain groups, marked as used only by custom domains", () => {
    const { required, optional } = splitPermissionGroups();
    const domains = optional.filter((g) => g.onlyFor === CUSTOM_DOMAINS_FEATURE);
    expect(domains.map(({ key, type }) => ({ key, type }))).toEqual([
      { key: "zone", type: "read" },
      { key: "dns", type: "edit" },
      { key: "workers_routes", type: "edit" },
    ]);
    expect(required.some((g) => ["zone", "dns", "workers_routes"].includes(g.key))).toBe(false);
    for (const { key, type } of domains) {
      expect(groupsOf(accountTokenTemplateUrl())).toContainEqual({ key, type });
    }
  });

  it("includes the Email Routing groups, marked as used only by Email Routing", () => {
    const { required, optional } = splitPermissionGroups();
    const email = optional.filter((g) => g.onlyFor === EMAIL_ROUTING_FEATURE);
    expect(email.map(({ key, type }) => ({ key, type }))).toEqual([
      { key: "zone_settings", type: "edit" },
      { key: "email_routing_rule", type: "edit" },
      { key: "email_routing_address", type: "read" },
    ]);
    expect(required.some((g) => g.key.startsWith("email_routing"))).toBe(false);
    for (const { key, type } of email) {
      expect(groupsOf(accountTokenTemplateUrl())).toContainEqual({ key, type });
    }
    // Every key appears once in the link.
    const keys = groupsOf(accountTokenTemplateUrl()).map((g: { key: string }) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("groups the optional permissions by the feature that uses them", () => {
    expect(
      optionalGroupsByFeature().map(({ feature, groups }) => ({
        feature,
        names: groups.map(permissionName),
      })),
    ).toEqual([
      {
        feature: ACCESS_FEATURE,
        names: [
          "Access: Apps and Policies: Edit",
          "Access: Organizations, Identity Providers, and Groups: Read",
        ],
      },
      {
        feature: CUSTOM_DOMAINS_FEATURE,
        names: ["Zone: Read", "DNS: Edit", "Workers Routes: Edit"],
      },
      { feature: EXTERNAL_DOMAINS_FEATURE, names: ["SSL and Certificates: Edit"] },
      {
        feature: EMAIL_ROUTING_FEATURE,
        names: [
          "Zone Settings: Edit",
          "Email Routing Rules: Edit",
          "Email Routing Addresses: Read",
        ],
      },
      { feature: PLAN_DETECTION_FEATURE, names: ["Billing: Read"] },
      { feature: SANDBOX_BUILDS_FEATURE, names: ["Containers: Edit"] },
      { feature: DATABASE_ELSEWHERE_FEATURE, names: ["Hyperdrive: Edit"] },
      {
        feature: PIPELINES_FEATURE,
        names: ["Pipelines: Edit", "Workers R2 Data Catalog: Edit (add by hand)"],
      },
    ]);
  });

  it("asks for Pipelines: Edit only as optional, for apps that stream events, under the dashboard's key", () => {
    const { required, optional } = splitPermissionGroups();
    expect(required.some((g) => g.key === "pipelines")).toBe(false);
    expect(optional.filter((g) => g.onlyFor === PIPELINES_FEATURE)).toEqual([
      { key: "pipelines", type: "edit", label: "Pipelines", onlyFor: PIPELINES_FEATURE },
      {
        key: "workers_r2_data_catalog",
        type: "edit",
        label: "Workers R2 Data Catalog",
        onlyFor: PIPELINES_FEATURE,
        manual: true,
      },
    ]);
    expect(groupsOf(accountTokenTemplateUrl())).toContainEqual({ key: "pipelines", type: "edit" });
    // Its key is not confirmed against the dashboard: Appflare's own link leaves it out.
    const own = JSON.stringify(groupsOf(accountTokenTemplateUrl()));
    expect(own).not.toContain("data_catalog");
    expect(own).not.toContain("r2_catalog");
    expect(
      resolveAppTokenPermissions([
        { group: "Pipelines", scope: "account", access: "edit", reason: "Streams events." },
      ]).map((p) => p.group?.key),
    ).toEqual(["pipelines"]);
  });

  it("asks for Hyperdrive: Edit only as optional, for apps with a database elsewhere, under the dashboard's key", () => {
    const { required, optional } = splitPermissionGroups();
    expect(required.some((g) => g.key === "query_cache")).toBe(false);
    expect(optional.filter((g) => g.onlyFor === DATABASE_ELSEWHERE_FEATURE)).toEqual([
      {
        key: "query_cache",
        type: "edit",
        label: "Hyperdrive",
        onlyFor: DATABASE_ELSEWHERE_FEATURE,
      },
    ]);
    expect(groupsOf(accountTokenTemplateUrl())).toContainEqual({
      key: "query_cache",
      type: "edit",
    });
    expect(groupsOf(userTokenTemplateUrl())).toContainEqual({ key: "query_cache", type: "edit" });
  });

  it("asks for Containers: Edit only as optional, for sandbox builds, under the dashboard's key", () => {
    const { required, optional } = splitPermissionGroups();
    expect(required.some((g) => g.key === "containers")).toBe(false);
    expect(optional.filter((g) => g.onlyFor === SANDBOX_BUILDS_FEATURE)).toEqual([
      { key: "containers", type: "edit", label: "Containers", onlyFor: SANDBOX_BUILDS_FEATURE },
    ]);
    expect(groupsOf(accountTokenTemplateUrl())).toContainEqual({ key: "containers", type: "edit" });
    expect(groupsOf(userTokenTemplateUrl())).toContainEqual({ key: "containers", type: "edit" });
  });

  it("asks for Billing: Read only as optional, for reading the Workers plan", () => {
    const { required, optional } = splitPermissionGroups();
    expect(required.some((g) => g.key === "billing")).toBe(false);
    expect(optional.filter((g) => g.onlyFor === PLAN_DETECTION_FEATURE)).toEqual([
      { key: "billing", type: "read", label: "Billing", onlyFor: PLAN_DETECTION_FEATURE },
    ]);
    expect(groupsOf(accountTokenTemplateUrl())).toContainEqual({ key: "billing", type: "read" });
  });
});

describe("app token permissions", () => {
  const perm = (
    scope: TokenPermission["scope"],
    group: string,
    access: TokenPermission["access"] = "edit",
    reason = "Needed.",
  ): TokenPermission => ({ scope, group, access, reason });

  function keysOf(permissions: TokenPermission[]) {
    return resolveAppTokenPermissions(permissions).map((p) =>
      p.group === null ? null : { key: p.group.key, type: p.group.type },
    );
  }

  it("takes each group's template key from the schema's list, at the access asked for", () => {
    expect(
      keysOf([
        perm("zone", "DNS"),
        perm("zone", "DNS", "read"),
        perm("account", "Workers KV Storage"),
        perm("account", "Hyperdrive", "read"),
        perm("account", "Access: Organizations, Identity Providers, and Groups", "read"),
      ]),
    ).toEqual([
      { key: "dns", type: "edit" },
      { key: "dns", type: "read" },
      { key: "workers_kv_storage", type: "edit" },
      { key: "query_cache", type: "read" },
      { key: "access_acct", type: "read" },
    ]);
  });

  it("finds a template key for every group the schema lets an app ask for", () => {
    const resolved = resolveAppTokenPermissions(
      APP_TOKEN_PERMISSION_GROUPS.map((g) => perm(g.scope, g.group)),
    );
    expect(resolved.filter((p) => p.group === null)).toEqual([]);
    expect(resolved.map((p) => p.group?.key)).toEqual(
      APP_TOKEN_PERMISSION_GROUPS.map((g) => g.templateKey),
    );
  });

  it("maps nothing for a group this version does not know, or one of the other scope", () => {
    expect(keysOf([perm("account", "Workers Quantum Storage"), perm("account", "DNS")])).toEqual([
      null,
      null,
    ]);
    expect(UNMAPPED_PERMISSION_REASON).toBe(
      "Not selected for you: Cloudflare's token link has no way to select it. Add it in the form.",
    );
  });

  it("keeps the scope, group, access and reason for display, labelled as the dashboard shows it", () => {
    const [dns, access] = resolveAppTokenPermissions([
      perm("zone", "DNS", "edit", "Updates the record for your home address."),
      perm("account", "Access: Apps and Policies", "read"),
    ]);
    expect(dns).toEqual({
      scope: "zone",
      groupName: "DNS",
      access: "edit",
      reason: "Updates the record for your home address.",
      group: { key: "dns", type: "edit", label: "Zone: DNS" },
    });
    expect(access?.group?.label).toBe("Access: Apps and Policies");
    const [unknown] = resolveAppTokenPermissions([perm("zone", "Something New")]);
    expect(unknown).toMatchObject({ groupName: "Something New", group: null });
  });

  it("prefills a user token form named after the app with the mapped groups only", () => {
    const url = appTokenTemplateUrl(
      "UniFi DDNS",
      resolveAppTokenPermissions([perm("zone", "DNS"), perm("zone", "Something New")]),
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
        perm("zone", "DNS", "read"),
        perm("zone", "DNS"),
        perm("zone", "Zone", "read"),
        perm("zone", "Zone", "read"),
      ]),
    );
    expect(groupsOf(url ?? "")).toEqual([
      { key: "dns", type: "edit" },
      { key: "zone", type: "read" },
    ]);
  });

  it("gives no link when no permission maps", () => {
    expect(appTokenTemplateUrl("App", resolveAppTokenPermissions([perm("zone", "Unknown")]))).toBe(
      null,
    );
    expect(appTokenTemplateUrl("App", [])).toBe(null);
  });
});
