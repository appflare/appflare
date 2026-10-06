import { describe, expect, it } from "vitest";
import { storedAccessProblem } from "../access/app-access";
import { ACCESS_MESSAGES, INSTALL_ACCESS_MESSAGES } from "../access/messages";
import { capabilitiesView } from "../capabilities/capabilities";
import { NO_CONTAINERS_PERMISSION_REASON, NO_R2_PERMISSION_REASON } from "../sandbox/preflight";
import { sandboxReadinessOf } from "../sandbox/readiness";
import {
  hasTokenWords,
  inConnectionWords,
  SIGN_IN_PERMISSION_FIX,
  SIGN_IN_WORDS,
} from "./sign-in-words";

const NO_PERMISSION = { state: "unknown", reason: "no-permission", detail: "HTTP 403" } as const;
const TOKEN_WORDS = /token|rotate|Edit the token|dashboard/i;

describe("permission refusals for a Cloudflare sign-in", () => {
  it("has a sign-in counterpart for every fixed token refusal, without token words", () => {
    const tokens = [
      ACCESS_MESSAGES.appsPermission,
      ACCESS_MESSAGES.organizationPermission,
      INSTALL_ACCESS_MESSAGES.policiesPermission,
      INSTALL_ACCESS_MESSAGES.tokensPermission,
      NO_CONTAINERS_PERMISSION_REASON,
      NO_R2_PERMISSION_REASON,
    ];
    expect([...SIGN_IN_WORDS.keys()].sort()).toEqual([...tokens].sort());
    for (const signIn of SIGN_IN_WORDS.values()) {
      expect(signIn).toContain(SIGN_IN_PERMISSION_FIX);
      expect(signIn).toContain("Reconnect Cloudflare");
      // "Access service tokens" is a Cloudflare product, not Appflare's token.
      const words = signIn.replace(SIGN_IN_PERMISSION_FIX, "").replace("service tokens", "");
      expect(words).not.toMatch(TOKEN_WORDS);
    }
  });

  it("keeps an API token's words exactly", () => {
    for (const token of SIGN_IN_WORDS.keys()) {
      expect(inConnectionWords("api_token", token)).toBe(token);
    }
  });

  it("rewords each token refusal inside a longer message, and leaves other words alone", () => {
    const joined = `preflight: ${NO_CONTAINERS_PERMISSION_REASON} ${NO_R2_PERMISSION_REASON}`;
    expect(hasTokenWords(joined)).toBe(true);
    const out = inConnectionWords("oauth", joined);
    expect(out.startsWith("preflight: Cloudflare did not let Appflare use Containers")).toBe(true);
    expect(out).toContain("use R2 with its Cloudflare sign-in");
    expect(out).not.toContain("API token");
    expect(hasTokenWords("Cloudflare is busy.")).toBe(false);
    expect(inConnectionWords("oauth", "Cloudflare is busy.")).toBe("Cloudflare is busy.");
  });

  it("words the stored Access problems for how Appflare connects", () => {
    const stored = { zeroTrust: NO_PERMISSION, accessServiceTokens: null };
    expect(storedAccessProblem(stored)?.message).toBe(ACCESS_MESSAGES.organizationPermission);
    expect(storedAccessProblem({ ...stored, connection: "oauth" })?.message).toBe(
      SIGN_IN_WORDS.get(ACCESS_MESSAGES.organizationPermission),
    );
  });

  it("words what sandbox builds lack for how Appflare connects", () => {
    const stored = {
      checkedAt: "2026-10-06T10:00:00.000Z",
      r2: { state: "enabled" },
      containers: NO_PERMISSION,
      workersPlan: NO_PERMISSION,
    } as const;
    const token = sandboxReadinessOf(capabilitiesView("paid", stored, "acc1"), false);
    expect(token.missing).toBe(NO_CONTAINERS_PERMISSION_REASON);
    const signIn = sandboxReadinessOf(capabilitiesView("paid", stored, "acc1", "oauth"), false);
    expect(signIn.missing).toBe(SIGN_IN_WORDS.get(NO_CONTAINERS_PERMISSION_REASON));
  });
});
