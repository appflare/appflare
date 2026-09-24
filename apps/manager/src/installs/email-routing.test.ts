import { describe, expect, it } from "vitest";
import { requirementSentence } from "../catalog/requirements";
import {
  DEFAULT_CATCH_ALL,
  deliversTo,
  describeAction,
  describeCatchAll,
  EMAIL_ROUTING_PERMISSION,
  type EmailRouteTarget,
  emailRouteCfId,
  emailRouteViews,
  emailRoutingChangeWarning,
  emailRoutingOfManifest,
  isCloudflareMx,
  parseEmailRouteCfId,
  planEmailRouting,
  SEND_EMAIL_NOTE,
  saveCatchAll,
  sendsEmail,
} from "./email-routing";

const ZONE = "0123456789abcdef0123456789abcdef";
const RULE = "a7e6fb77503c41d8a7f3113c6918f10c";

describe("planEmailRouting", () => {
  it("puts local parts in the zone and keeps full addresses in it", () => {
    expect(planEmailRouting({ rules: ["inbox", "bills@example.com"] }, "Example.com")).toEqual({
      ok: true,
      plan: {
        zoneName: "example.com",
        addresses: ["inbox@example.com", "bills@example.com"],
        catchAll: false,
      },
    });
    expect(planEmailRouting({ catchAll: true }, "example.com")).toEqual({
      ok: true,
      plan: { zoneName: "example.com", addresses: [], catchAll: true },
    });
  });

  it("refuses an address outside the zone, subdomains included", () => {
    for (const rule of ["inbox@other.com", "inbox@mail.example.com"]) {
      const planned = planEmailRouting({ rules: [rule] }, "example.com");
      expect(planned.ok, rule).toBe(false);
    }
  });

  it("refuses an address longer than a rule can match", () => {
    const planned = planEmailRouting({ rules: ["a".repeat(64)] }, `${"b".repeat(30)}.com`);
    expect(planned.ok).toBe(false);
  });

  it("routes an address given both ways once", () => {
    const planned = planEmailRouting({ rules: ["inbox", "inbox@example.com"] }, "example.com");
    expect(planned.ok && planned.plan.addresses).toEqual(["inbox@example.com"]);
  });
});

describe("email route records", () => {
  it("round-trips each target through cf_id", () => {
    const targets: EmailRouteTarget[] = [
      { kind: "rule", zoneId: ZONE, ruleId: RULE },
      { kind: "catch_all", zoneId: ZONE, previous: null },
      { kind: "catch_all", zoneId: ZONE, previous: DEFAULT_CATCH_ALL },
      {
        kind: "catch_all",
        zoneId: ZONE,
        previous: { enabled: false, actions: [{ type: "forward", value: ["zoë@example.net"] }] },
      },
      { kind: "routing", zoneId: ZONE },
    ];
    for (const target of targets) {
      expect(parseEmailRouteCfId(emailRouteCfId(target))).toEqual(target);
    }
  });

  it("rejects anything Appflare did not write", () => {
    for (const cfId of [
      null,
      "",
      "rule",
      `rule:${ZONE}`,
      `rule:${ZONE}:${RULE}:x`,
      `catch_all:${ZONE}:${RULE}`,
      `catch_all:${ZONE}:${btoa(JSON.stringify({ enabled: "yes" }))}`,
      `routing:${ZONE}:${RULE}`,
      `domain:${ZONE}`,
      "routing:zone id with spaces",
    ]) {
      expect(parseEmailRouteCfId(cfId), String(cfId)).toBeNull();
    }
  });

  it("describes each record for the install page and the uninstall dialog", () => {
    const views = emailRouteViews([
      { id: "r1", name: "inbox@example.com", cfId: `rule:${ZONE}:${RULE}` },
      {
        id: "r2",
        name: "*@example.com",
        cfId: emailRouteCfId({
          kind: "catch_all",
          zoneId: ZONE,
          previous: { enabled: false, actions: [{ type: "forward", value: ["me@example.net"] }] },
        }),
      },
      { id: "r3", name: "example.com", cfId: `routing:${ZONE}` },
      { id: "r4", name: "broken", cfId: null },
    ]);
    expect(views.map((v) => [v.id, v.kind])).toEqual([
      ["r1", "rule"],
      ["r2", "catch_all"],
      ["r3", "routing"],
    ]);
    expect(views[0]?.label).toBe("Mail to inbox@example.com goes to the app");
    expect(views[1]?.onUninstall).toBe(
      "Puts the catch-all of example.com back as it was before the install (forwarding to me@example.net, off), if it still points at the app.",
    );
    expect(views[2]?.onUninstall).toContain("if no other routing rule or catch-all is left");
  });
});

describe("the catch-all before an install", () => {
  it("keeps the first action and the on/off state", () => {
    expect(
      saveCatchAll({
        enabled: true,
        actions: [{ type: "drop" }, { type: "forward", value: ["x@example.net"] }],
      }),
    ).toEqual({ enabled: true, actions: [{ type: "drop" }] });
    expect(describeCatchAll(DEFAULT_CATCH_ALL)).toBe("drop, off");
  });

  it("falls back to drop and off for a shape it cannot keep", () => {
    expect(
      saveCatchAll({ enabled: false, actions: [{ type: "forward", value: ["x".repeat(91)] }] }),
    ).toEqual(DEFAULT_CATCH_ALL);
  });
});

describe("email routing across versions", () => {
  it("warns only when a version receives different email", () => {
    expect(
      emailRoutingChangeWarning({ rules: ["a", "b"] }, { rules: ["b", "a"] }, "2.0.0"),
    ).toBeNull();
    expect(emailRoutingChangeWarning(null, undefined, "2.0.0")).toBeNull();
    const warning = emailRoutingChangeWarning({ rules: ["inbox"] }, { catchAll: true }, "2.0.0");
    expect(warning).toContain(
      "Version 2.0.0 receives the catch-all; the installed one receives inbox.",
    );
    expect(warning).toContain("does not change Email Routing on an update or rollback");
    expect(emailRoutingChangeWarning(null, { rules: ["inbox"] }, "2.0.0")).toContain(
      "the installed one receives no email",
    );
  });

  it("reads emailRouting from a stored manifest, and nothing from a broken one", () => {
    expect(emailRoutingOfManifest(null)).toBeNull();
    expect(emailRoutingOfManifest("{not json")).toBeNull();
    expect(emailRoutingOfManifest("{}")).toBeNull();
  });
});

describe("rule actions", () => {
  it("recognises delivery to exactly one Worker", () => {
    expect(deliversTo([{ type: "worker", value: ["inbox"] }], "inbox")).toBe(true);
    expect(deliversTo([{ type: "worker", value: ["inbox-2"] }], "inbox")).toBe(false);
    expect(deliversTo([{ type: "forward", value: ["inbox"] }], "inbox")).toBe(false);
    expect(deliversTo([], "inbox")).toBe(false);
  });

  it("describes actions for people", () => {
    expect(describeAction([{ type: "forward", value: ["me@example.net"] }])).toBe(
      "forwarding to me@example.net",
    );
    expect(describeAction([{ type: "worker", value: ["other"] }])).toBe("the Worker other");
    expect(describeAction([{ type: "drop" }])).toBe("drop");
  });

  it("tells Cloudflare's mail servers from other providers'", () => {
    expect(isCloudflareMx("route1.mx.cloudflare.net")).toBe(true);
    expect(isCloudflareMx("route2.mx.cloudflare.net.")).toBe(true);
    expect(isCloudflareMx("aspmx.l.google.com")).toBe(false);
    expect(isCloudflareMx("mx.cloudflare.net.evil.example")).toBe(false);
  });
});

describe("sending", () => {
  it("adds the sending note only for a send_email binding", () => {
    expect(sendsEmail([{ type: "kv_namespace" }, { type: "send_email" }])).toBe(true);
    expect(sendsEmail([{ type: "kv_namespace" }])).toBe(false);
    expect(SEND_EMAIL_NOTE).toContain("verified destination addresses");
    expect(SEND_EMAIL_NOTE).toContain("Workers Paid");
  });
});

describe("permissions and wording", () => {
  it("names the permissions as the token form lists them", () => {
    expect(EMAIL_ROUTING_PERMISSION).toEqual({
      zone: "Zone: Read",
      dns: "DNS: Edit",
      zoneSettings: "Zone Settings: Edit",
      rules: "Email Routing Rules: Edit",
      addresses: "Email Routing Addresses: Read",
    });
  });

  it("says Appflare sets Email Routing up only for apps that ask for it", () => {
    const generic = requirementSentence("email-routing", { tier: "artifact" });
    const provisioned = requirementSentence("email-routing", {
      tier: "artifact",
      provisionsEmailRouting: true,
    });
    expect(generic).toContain("must be enabled");
    expect(provisioned).toContain("Appflare turns Email Routing on");
    expect(requirementSentence("zone", { tier: "artifact", provisionsEmailRouting: true })).toBe(
      requirementSentence("zone", { tier: "artifact" }),
    );
  });
});
