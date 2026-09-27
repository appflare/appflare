import { describe, expect, it } from "vitest";
import {
  ACCESS_FEATURE,
  type AppTokenPermission,
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
  unmappedPermissionReason,
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
      resolveAppTokenPermissions([{ name: "Account.Pipelines:Edit" }]).map((p) => p.group?.key),
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

  it("maps the Access groups an app that creates its own Access application needs", () => {
    expect(
      keysOf([
        { name: "Access: Apps and Policies", scope: "account" },
        { name: "Access: Organizations, Identity Providers, and Groups:Read", scope: "account" },
      ]),
    ).toEqual([
      { key: "access", type: "edit" },
      { key: "access_acct", type: "read" },
    ]);
  });

  it("maps nothing for unknown names, bare names without a scope, or a contradicting scope", () => {
    expect(
      keysOf([
        { name: "Zone.Email Routing Addresses" },
        { name: "DNS" },
        { name: "Zone.DNS", scope: "account" },
        { name: "User.Memberships", scope: "user" },
      ]),
    ).toEqual([null, null, null, null]);
  });

  it("says in one line why the link cannot select a permission", () => {
    const [unknown, bare] = resolveAppTokenPermissions([
      { name: "User.Memberships", scope: "user" },
      { name: "DNS" },
    ]);
    expect(unmappedPermissionReason(unknown as AppTokenPermission)).toBe(
      "Not selected for you: Cloudflare's token link has no way to select it. Add it in the form.",
    );
    expect(unmappedPermissionReason(bare as AppTokenPermission)).toContain(
      "does not say whether it is an account or a zone permission",
    );
  });

  it("finds a template key for every permission the catalog's apps ask for", () => {
    // Every tokenPermissions name in the published catalog, plus the Pipelines
    // sink token's, so none of them is left out of an app's token link.
    const names: Array<{ name: string; scope?: "account" | "zone" }> = [
      { name: "Zone.DNS", scope: "zone" },
      { name: "Zone.Zone:Read", scope: "zone" },
      { name: "Zone.DNS:Edit", scope: "zone" },
      { name: "Zone.Zone Settings:Edit", scope: "zone" },
      { name: "Zone.Zone Settings:Read", scope: "zone" },
      { name: "Zone.Email Routing Rules:Edit", scope: "zone" },
      { name: "Account.Email Sending:Edit", scope: "account" },
      { name: "Account.Email Routing Addresses:Read", scope: "account" },
      { name: "Workers Scripts", scope: "account" },
      { name: "Workers KV Storage", scope: "account" },
      { name: "D1", scope: "account" },
      { name: "Workers R2 Storage", scope: "account" },
      { name: "Secrets Store:Edit", scope: "account" },
      { name: "Account Settings:Read", scope: "account" },
      { name: "Access: Apps and Policies", scope: "account" },
      { name: "Access: Organizations, Identity Providers, and Groups", scope: "account" },
      { name: "Account.Account Analytics:Read", scope: "account" },
      { name: "Zone.SSL and Certificates:Edit", scope: "zone" },
      { name: "Zone.Analytics:Read", scope: "zone" },
      { name: "Account.Workers Scripts:Read", scope: "account" },
      { name: "Zone.SSL and Certificates:Read", scope: "zone" },
      { name: "Zone.Firewall Services:Read", scope: "zone" },
      { name: "Zone.Load Balancers:Read", scope: "zone" },
      { name: "Account.Logs:Read", scope: "account" },
      { name: "Account.Magic Transit:Read", scope: "account" },
      { name: "Account.Workers R2 Storage:Edit" },
      { name: "Account.Workers R2 Data Catalog:Edit" },
      { name: "Account.Workers R2 SQL:Read" },
    ];
    const resolved = resolveAppTokenPermissions(names);
    expect(resolved.filter((p) => p.group === null).map((p) => p.name)).toEqual([]);
    expect(
      resolved.slice(-9).map((p) => p.group && { key: p.group.key, type: p.group.type }),
    ).toEqual([
      { key: "workers_scripts", type: "read" },
      { key: "ssl_and_certificates", type: "read" },
      { key: "firewall_services", type: "read" },
      { key: "load_balancers", type: "read" },
      { key: "account_logs", type: "read" },
      { key: "magic_transit", type: "read" },
      { key: "workers_r2", type: "edit" },
      { key: "r2_catalog", type: "edit" },
      { key: "r2_catalog_sql", type: "read" },
    ]);
    expect(keysOf([{ name: "Zone.Email Routing Rules:Edit" }])).toEqual([
      { key: "email_routing_rule", type: "edit" },
    ]);
    expect(keysOf([{ name: "Account.Email Sending:Edit" }])).toEqual([
      { key: "email_sending", type: "edit" },
    ]);
    expect(keysOf([{ name: "Secrets Store:Edit", scope: "account" }])).toEqual([
      { key: "secrets_store", type: "edit" },
    ]);
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
        { name: "Zone.Email Routing Addresses", scope: "zone" },
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
