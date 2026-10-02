import { describe, expect, it } from "vitest";
import { fakeAccessAccount } from "../test/fake-access-account";
import { INSTALL_ACCESS_MESSAGES } from "./install-access.server";
import { accessCapabilityProblem } from "./preflight.server";
import { ACCESS_MESSAGES } from "./toggle.server";

/** Whether the account can protect apps, in the words the protection refuses with. */
describe("accessCapabilityProblem", () => {
  it("finds nothing wrong with an organization and a token that reads Access", async () => {
    const cf = fakeAccessAccount();
    expect(await accessCapabilityProblem(cf.client)).toBeNull();
  });

  it("says the account has no Zero Trust organization", async () => {
    const cf = fakeAccessAccount();
    cf.organization.current = null;
    expect(await accessCapabilityProblem(cf.client)).toBe(ACCESS_MESSAGES.noOrganization);
  });

  it("names the permission the token lacks", async () => {
    const org = fakeAccessAccount();
    org.forbidden.add("GET /accounts/*");
    expect(await accessCapabilityProblem(org.client)).toBe(ACCESS_MESSAGES.organizationPermission);

    const apps = fakeAccessAccount();
    apps.forbidden.add(`GET /accounts/${"acc0000000000000000000000000000a"}/access/apps`);
    expect(await accessCapabilityProblem(apps.client)).toBe(
      INSTALL_ACCESS_MESSAGES.policiesPermission,
    );

    const tokens = fakeAccessAccount();
    tokens.forbidden.add(
      `GET /accounts/${"acc0000000000000000000000000000a"}/access/service_tokens`,
    );
    expect(await accessCapabilityProblem(tokens.client)).toBe(
      INSTALL_ACCESS_MESSAGES.tokensPermission,
    );
  });

  it("refuses a team domain Appflare cannot verify tokens from", async () => {
    const cf = fakeAccessAccount();
    cf.organization.current = { auth_domain: "login.example.com", name: "x" };
    expect(await accessCapabilityProblem(cf.client)).toContain("not a cloudflareaccess.com domain");
  });
});
