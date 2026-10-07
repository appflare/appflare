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
import { TOKEN_REFUSALS } from "./token-refusals";

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

describe("refusals that carry names, for a Cloudflare sign-in", () => {
  const said = "HTTP 403: [10000] Authentication error";
  /** Each token refusal as its module builds it, and what its sign-in words must keep. */
  const cases: Array<[string, string, string[]]> = [
    [
      "attaching a custom domain",
      TOKEN_REFUSALS.attachDomain(
        "go.example.com",
        "example.com",
        "Workers Routes: Edit",
        "DNS: Edit",
      ),
      ["attach go.example.com"],
    ],
    ["reading a zone", TOKEN_REFUSALS.zoneHidden("Zone: Read, DNS: Edit"), ["see that domain"]],
    ["Email Routing's zone", TOKEN_REFUSALS.emailZoneHidden, ["see that domain"]],
    ["the gateway's zone", TOKEN_REFUSALS.gatewayZoneHidden, ["see that domain"]],
    [
      "destination addresses",
      TOKEN_REFUSALS.destinationAddresses("Email Routing Addresses: Read"),
      ["destination addresses", "which ones are verified"],
    ],
    [
      "an Email Routing call",
      TOKEN_REFUSALS.emailRoutingCall("create a routing rule", said, "Email Routing Rules: Edit"),
      ["create a routing rule", said],
    ],
    [
      "a gateway call",
      TOKEN_REFUSALS.gatewayCall("example.com", "SSL and Certificates: Edit"),
      ["a call on example.com"],
    ],
    [
      "removing an external domain",
      TOKEN_REFUSALS.removeDomain(
        "external domain",
        "go.example.org",
        said,
        "SSL and Certificates: Edit",
        "the gateway domain",
      ),
      ["external domain go.example.org", said, "retry the uninstall"],
    ],
    [
      "removing a wildcard domain",
      TOKEN_REFUSALS.removeDomain(
        "wildcard domain",
        "*.example.com",
        said,
        "Workers Routes: Edit and DNS: Edit",
        "its zone",
      ),
      ["wildcard domain *.example.com", "retry the uninstall"],
    ],
    [
      "the email domain out of sight",
      `${TOKEN_REFUSALS.emailZoneGone("example.com", "Zone: Read")} Nothing was changed.`,
      [
        "Appflare cannot see example.com, the domain the app receives email for",
        "Nothing was changed.",
      ],
    ],
    [
      "what setting up email lacks",
      `${TOKEN_REFUSALS.emailPermissions("Email Routing Rules: Edit, Zone: Read", "setting up the app's email")}. Nothing was changed.`,
      ["setting up the app's email", "Nothing was changed."],
    ],
    [
      "what an update's email lacks, as a sentence of its own",
      `The${TOKEN_REFUSALS.emailPermissions("Email Routing Rules: Edit", "setting up this version's email").slice("the".length)}, so nothing new is set up for it.`,
      ["setting up this version's email", "so nothing new is set up for it."],
    ],
    [
      "what receiving email lacks at install",
      `${TOKEN_REFUSALS.emailPermissions("Email Routing Rules: Edit", "receiving email")} and install again`,
      ["receiving email", "and install again"],
    ],
    ["Hyperdrive", TOKEN_REFUSALS.hyperdrive(said, "Hyperdrive: Edit"), ["Hyperdrive call", said]],
    [
      "checking Access",
      INSTALL_ACCESS_MESSAGES.unchecked("HTTP 500"),
      ["Appflare's Cloudflare sign-in can protect apps", "HTTP 500"],
    ],
  ];

  it.each(cases)("rewords %s without token words, keeping its names", (_name, token, kept) => {
    expect(hasTokenWords(token)).toBe(true);
    expect(inConnectionWords("api_token", token)).toBe(token);
    const signIn = inConnectionWords("oauth", `step: ${token}`);
    expect(signIn.startsWith("step: ")).toBe(true);
    for (const part of kept) expect(signIn).toContain(part);
    // Cloudflare's own words may say "token"; Appflare's may not.
    expect(signIn.replaceAll(said, "")).not.toMatch(/\btoken\b|API Tokens|Edit the/i);
  });

  it("says to reconnect wherever there is something to do", () => {
    for (const [, token] of cases.slice(0, -1)) {
      expect(inConnectionWords("oauth", token)).toContain("Reconnect Cloudflare");
    }
  });
});
