import { describe, expect, it } from "vitest";
import {
  accessProblemFix,
  accessRepairOf,
  publicPathsLine,
  signInNote,
  storedAccessProblem,
  whoGetsIn,
  zeroTrustUsersNote,
} from "./app-access";
import { ACCESS_MESSAGES, INSTALL_ACCESS_MESSAGES } from "./messages";

describe("storedAccessProblem", () => {
  it("reads what the stored probes already show, and nothing else", () => {
    expect(storedAccessProblem(null)).toBeNull();
    expect(storedAccessProblem({ zeroTrust: null, accessServiceTokens: null })).toBeNull();
    expect(
      storedAccessProblem({
        zeroTrust: { state: "exists", teamDomain: "acme.cloudflareaccess.com" },
        accessServiceTokens: { state: "readable" },
      }),
    ).toBeNull();
    expect(
      storedAccessProblem({ zeroTrust: { state: "none" }, accessServiceTokens: null }),
    ).toEqual({ kind: "no-organization", message: ACCESS_MESSAGES.noOrganization });
    expect(
      storedAccessProblem({
        zeroTrust: { state: "unknown", reason: "no-permission", detail: "403" },
        accessServiceTokens: null,
      }),
    ).toEqual({
      kind: "organization-permission",
      message: ACCESS_MESSAGES.organizationPermission,
    });
    expect(
      storedAccessProblem({
        zeroTrust: { state: "exists", teamDomain: "acme.cloudflareaccess.com" },
        accessServiceTokens: { state: "unknown", reason: "no-permission", detail: "403" },
      }),
    ).toEqual({ kind: "tokens-permission", message: INSTALL_ACCESS_MESSAGES.tokensPermission });
    // A check that failed for another reason stands in the way of nothing.
    expect(
      storedAccessProblem({
        zeroTrust: { state: "unknown", reason: "error", detail: "500" },
        accessServiceTokens: null,
      }),
    ).toBeNull();
  });

  it("sends each problem to its row of What this account can run", () => {
    expect(accessProblemFix("no-organization").href).toBe(
      "/settings/account#capability-zero-trust",
    );
    expect(accessProblemFix("policies-permission").href).toBe(
      "/settings/account#capability-token-permissions",
    );
  });
});

describe("the words", () => {
  it("adds the Zero Trust Free line only above 50 users", () => {
    expect(zeroTrustUsersNote(null)).toBeNull();
    expect(zeroTrustUsersNote(50)).toBeNull();
    expect(zeroTrustUsersNote(51)).toBe("Zero Trust Free covers up to 50 users; Appflare has 51.");
  });

  it("says who gets in", () => {
    expect(whoGetsIn(1)).toBe("Only Appflare's users get in: 1 person, members included.");
    expect(whoGetsIn(4)).toBe("Only Appflare's users get in: 4 people, members included.");
    expect(whoGetsIn(null)).toBe("Only Appflare's users get in, members included.");
  });

  it("says how they sign in, and what to add when not every email can", () => {
    expect(signInNote({ loginMethods: null, oneTimePin: false })).toBe(
      "Each signs in to Cloudflare Access first, with the email of their Appflare account.",
    );
    expect(signInNote({ loginMethods: ["One-time PIN"], oneTimePin: true })).toContain(
      "Login methods: One-time PIN.",
    );
    expect(signInNote({ loginMethods: ["GitHub"], oneTimePin: false })).toContain(
      "add One-time PIN in the Zero Trust dashboard to let any email in",
    );
    expect(signInNote({ loginMethods: [], oneTimePin: false })).toContain(
      "has no login methods yet",
    );
  });

  it("says what stays public", () => {
    expect(publicPathsLine([])).toContain("links you share with others included");
    expect(publicPathsLine(["/s/*", "/hook"])).toBe("Stays public: /s/*, /hook");
  });
});

describe("accessRepairOf", () => {
  const healthy = {
    protected: true,
    syncFailed: false,
    probesPolicyId: "apol-1",
    aud: "aud-1",
    teamDomain: "acme.cloudflareaccess.com",
    usersPolicyId: "users-1",
    currentUsersPolicyId: "users-1",
  };

  it("finds nothing to repair in a complete record, or for an app that is not protected", () => {
    expect(accessRepairOf(healthy)).toBeNull();
    expect(accessRepairOf({ ...healthy, protected: false, syncFailed: true })).toBeNull();
  });

  it("puts a deleted application first: it lets everyone in", () => {
    expect(
      accessRepairOf({
        ...healthy,
        appMissing: true,
        currentUsersPolicyId: null,
        syncFailed: true,
      }),
    ).toBe("app-deleted");
    expect(accessRepairOf({ ...healthy, appMissing: false })).toBeNull();
  });

  it("puts what keeps everyone out next", () => {
    expect(
      accessRepairOf({ ...healthy, currentUsersPolicyId: null, syncFailed: true, aud: null }),
    ).toBe("users-policy-missing");
    expect(accessRepairOf({ ...healthy, usersPolicyId: "users-0", aud: null })).toBe(
      "users-policy-replaced",
    );
    expect(accessRepairOf({ ...healthy, usersPolicyId: null })).toBe("users-policy-replaced");
    expect(accessRepairOf({ ...healthy, probesPolicyId: null, syncFailed: true })).toBe(
      "incomplete",
    );
    expect(accessRepairOf({ ...healthy, teamDomain: null })).toBe("incomplete");
    expect(accessRepairOf({ ...healthy, syncFailed: true })).toBe("sync-failed");
  });
});
