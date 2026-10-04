import { createClient } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { fakeAccessAccount } from "../test/fake-access-account";
import { INSTALL_ACCESS_MESSAGES } from "./install-access.server";
import {
  accessCapabilityCheck,
  accessCapabilityProblem,
  accessInstallRefusal,
} from "./preflight.server";
import { ACCESS_MESSAGES } from "./toggle.server";

/** The words of `accessCapabilityProblem`'s answer; null when nothing stands in the way. */
async function problemOf(client: Parameters<typeof accessCapabilityProblem>[0]) {
  return (await accessCapabilityProblem(client))?.message ?? null;
}

/** Whether the account can protect apps, in the words the protection refuses with. */
describe("accessCapabilityProblem", () => {
  it("finds nothing wrong with an organization and a token that reads Access", async () => {
    const cf = fakeAccessAccount();
    expect(await problemOf(cf.client)).toBeNull();
  });

  it("says the account has no Zero Trust organization", async () => {
    const cf = fakeAccessAccount();
    cf.organization.current = null;
    expect(await problemOf(cf.client)).toBe(ACCESS_MESSAGES.noOrganization);
  });

  it("names the permission the token lacks", async () => {
    const org = fakeAccessAccount();
    org.forbidden.add("GET /accounts/*");
    expect(await problemOf(org.client)).toBe(ACCESS_MESSAGES.organizationPermission);

    const apps = fakeAccessAccount();
    apps.forbidden.add(`GET /accounts/${"acc0000000000000000000000000000a"}/access/apps`);
    expect(await problemOf(apps.client)).toBe(INSTALL_ACCESS_MESSAGES.policiesPermission);

    const tokens = fakeAccessAccount();
    tokens.forbidden.add(
      `GET /accounts/${"acc0000000000000000000000000000a"}/access/service_tokens`,
    );
    expect(await problemOf(tokens.client)).toBe(INSTALL_ACCESS_MESSAGES.tokensPermission);
  });

  it("refuses a team domain Appflare cannot verify tokens from", async () => {
    const cf = fakeAccessAccount();
    cf.organization.current = { auth_domain: "login.example.com", name: "x" };
    expect(await problemOf(cf.client)).toContain("not a cloudflareaccess.com domain");
  });

  it("refuses to start on a read that gave no answer, and still checks the others", async () => {
    const cf = fakeAccessAccount();
    const A = "/client/v4/accounts/acc0000000000000000000000000000a";
    const down = new Set<string>();
    const client = createClient({
      accountId: "acc0000000000000000000000000000a",
      token: "cf-token-DO-NOT-LEAK",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (down.has(new URL(request.url).pathname)) {
          return Response.json(
            { success: false, errors: [{ code: 10001, message: "internal" }] },
            { status: 500 },
          );
        }
        return cf.fetch(input, init);
      },
    });

    down.add(`${A}/access/organizations`);
    const problem = await accessCapabilityProblem(client);
    expect(problem).toMatchObject({ unchecked: true });
    expect(problem?.message).toContain("could not ask Cloudflare");
    expect(problem?.message).not.toContain("DO-NOT-LEAK");
    // An install says only that, not that the account lacks something.
    if (problem === null) throw new Error("no answer");
    expect(accessInstallRefusal("Cut", problem)).toBe(problem.message);
    // Shown on the install form: nothing is known to stand in the way.
    expect(await accessCapabilityCheck(client)).toBeNull();

    // An organization that cannot be read does not hide a missing permission.
    cf.forbidden.add("GET /accounts/acc0000000000000000000000000000a/access/service_tokens");
    expect(await accessCapabilityProblem(client)).toEqual({
      message: INSTALL_ACCESS_MESSAGES.tokensPermission,
      unchecked: false,
    });
    expect(
      accessInstallRefusal("Cut", {
        message: INSTALL_ACCESS_MESSAGES.tokensPermission,
        unchecked: false,
      }),
    ).toBe(
      `Cut needs Cloudflare Access, which this account cannot provide yet: ${INSTALL_ACCESS_MESSAGES.tokensPermission}`,
    );
    expect((await accessCapabilityCheck(client))?.kind).toBe("tokens-permission");

    cf.forbidden.clear();
    down.clear();
    down.add(`${A}/access/service_tokens`);
    expect(await problemOf(client)).toContain("could not ask Cloudflare");
  });
});
