import { describe, expect, it } from "vitest";
import {
  accountTokenTemplateUrl,
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
