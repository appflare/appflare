import { describe, expect, it } from "vitest";
import {
  capabilitiesView,
  manualPlanControl,
  paidPlanBadge,
  parseStoredCapabilities,
  requirementBadge,
  resolveAccountPlan,
  type StoredCapabilities,
  unknownSentence,
} from "./capabilities";

const NO_PERMISSION = {
  state: "unknown",
  reason: "no-permission",
  detail:
    "Cloudflare API request failed: GET /accounts/a/subscriptions -> 403: [10000] Authentication error",
} as const;

function stored(overrides: Partial<StoredCapabilities> = {}): StoredCapabilities {
  return {
    checkedAt: "2026-09-24T10:00:00.000Z",
    r2: { state: "enabled" },
    containers: NO_PERMISSION,
    workersPlan: NO_PERMISSION,
    ...overrides,
  };
}

describe("the stored capabilities row", () => {
  it("round-trips through JSON and refuses anything else", () => {
    const value = stored({ workersPlan: { state: "paid" } });
    expect(parseStoredCapabilities(JSON.stringify(value))).toEqual(value);
    expect(parseStoredCapabilities(undefined)).toBeNull();
    expect(parseStoredCapabilities("not json")).toBeNull();
    expect(
      parseStoredCapabilities(JSON.stringify({ checkedAt: "x", r2: { state: "on" } })),
    ).toBeNull();
  });

  it("keeps the Analytics Engine probe, and reads rows without it as not checked", () => {
    const withIt = stored({ analyticsEngine: { state: "not-enabled" } });
    expect(parseStoredCapabilities(JSON.stringify(withIt))).toEqual(withIt);
    expect(capabilitiesView(null, stored()).analyticsEngine).toBeNull();
    expect(
      parseStoredCapabilities(JSON.stringify({ ...withIt, analyticsEngine: { state: "on" } })),
    ).toBeNull();
  });

  it("keeps the domain probes, and still reads rows written before they existed", () => {
    const withDomains = stored({ zone: { state: "none" }, emailRouting: { state: "no-zone" } });
    expect(parseStoredCapabilities(JSON.stringify(withDomains))).toEqual(withDomains);
    // A row from before: the plan it detected must survive the upgrade.
    const before = stored({ workersPlan: { state: "free" } });
    const parsed = parseStoredCapabilities(JSON.stringify(before));
    expect(parsed).toEqual(before);
    expect(capabilitiesView(null, parsed)).toMatchObject({
      zone: null,
      emailRouting: null,
      plan: { plan: "free", source: "detected" },
    });
    expect(
      parseStoredCapabilities(JSON.stringify({ ...before, zone: { state: "maybe" } })),
    ).toBeNull();
  });
});

describe("the Workers plan in force", () => {
  it("takes the detected plan over the one an admin set", () => {
    expect(resolveAccountPlan("paid", stored({ workersPlan: { state: "free" } }))).toEqual({
      plan: "free",
      source: "detected",
    });
    expect(resolveAccountPlan("free", stored({ workersPlan: { state: "paid" } }))).toEqual({
      plan: "paid",
      source: "detected",
    });
  });

  it("takes Containers answering as Workers Paid over subscriptions without a Workers entry", () => {
    expect(
      resolveAccountPlan(
        null,
        stored({ workersPlan: { state: "free" }, containers: { state: "available" } }),
      ),
    ).toEqual({ plan: "paid", source: "detected" });
  });

  it("detects paid from Containers when the subscriptions cannot be read", () => {
    expect(resolveAccountPlan(null, stored({ containers: { state: "available" } }))).toEqual({
      plan: "paid",
      source: "detected",
    });
  });

  it("falls back to the admin's setting, then to free", () => {
    expect(resolveAccountPlan("paid", stored())).toEqual({ plan: "paid", source: "set-by-you" });
    expect(resolveAccountPlan("paid", null)).toEqual({ plan: "paid", source: "set-by-you" });
    expect(resolveAccountPlan(undefined, stored())).toEqual({ plan: "free", source: "default" });
    expect(resolveAccountPlan("enterprise", null)).toEqual({ plan: "free", source: "default" });
  });
});

describe("requirement badges", () => {
  it("say what the probes found about R2", () => {
    expect(requirementBadge("r2", capabilitiesView(null, stored()))).toEqual({
      met: true,
      label: "Detected: enabled",
    });
    expect(
      requirementBadge("r2", capabilitiesView(null, stored({ r2: { state: "not-enabled" } }))),
    ).toEqual({ met: false, label: "Detected: not enabled" });
    expect(
      requirementBadge("r2", capabilitiesView(null, stored({ r2: NO_PERMISSION }))),
    ).toBeNull();
    expect(requirementBadge("r2", capabilitiesView(null, null))).toBeNull();
  });

  it("say what the probes found about Containers, else what the plan says", () => {
    expect(
      requirementBadge(
        "containers",
        capabilitiesView(null, stored({ containers: { state: "needs-workers-paid" } })),
      ),
    ).toEqual({ met: false, label: "Detected: needs Workers Paid" });
    expect(requirementBadge("containers", capabilitiesView("paid", stored()))).toEqual({
      met: true,
      label: "Set by you: Workers Paid",
    });
    expect(
      requirementBadge(
        "containers",
        capabilitiesView(null, stored({ workersPlan: { state: "paid" } })),
      ),
    ).toEqual({ met: true, label: "Detected: Workers Paid" });
    expect(requirementBadge("containers", capabilitiesView("free", stored()))).toBeNull();
  });

  it("say what the probes found about domains and Email Routing", () => {
    const found = capabilitiesView(
      null,
      stored({ zone: { state: "available" }, emailRouting: { state: "available" } }),
    );
    expect(requirementBadge("zone", found)).toEqual({
      met: true,
      label: "Detected: active zone found",
    });
    expect(requirementBadge("email-routing", found)).toEqual({
      met: true,
      label: "Detected: available",
    });
    const none = capabilitiesView(
      null,
      stored({ zone: { state: "none" }, emailRouting: { state: "no-zone" } }),
    );
    expect(requirementBadge("zone", none)).toEqual({
      met: false,
      label: "Detected: no active zone",
    });
    expect(requirementBadge("email-routing", none)).toEqual({
      met: false,
      label: "Detected: no active zone",
    });
    const refused = capabilitiesView(
      null,
      stored({ zone: { state: "available" }, emailRouting: NO_PERMISSION }),
    );
    expect(requirementBadge("email-routing", refused)).toBeNull();
  });

  it("say what the probe found about Analytics Engine", () => {
    const on = capabilitiesView(null, stored({ analyticsEngine: { state: "enabled" } }));
    expect(requirementBadge("analytics-engine", on)).toEqual({
      met: true,
      label: "Detected: turned on",
    });
    const off = capabilitiesView(null, stored({ analyticsEngine: { state: "not-enabled" } }));
    expect(requirementBadge("analytics-engine", off)).toEqual({
      met: false,
      label: "Detected: not turned on",
    });
    const refused = capabilitiesView(null, stored({ analyticsEngine: NO_PERMISSION }));
    expect(requirementBadge("analytics-engine", refused)).toBeNull();
    expect(requirementBadge("analytics-engine", capabilitiesView(null, stored()))).toBeNull();
  });

  it("say nothing for requirements the probes do not cover or have not checked", () => {
    expect(requirementBadge("zone", capabilitiesView("paid", stored()))).toBeNull();
    expect(requirementBadge("email-routing", capabilitiesView("paid", stored()))).toBeNull();
    expect(requirementBadge("access", capabilitiesView("paid", stored()))).toBeNull();
  });

  it("show the plan for apps that need Workers Paid, warning only when Cloudflare says free", () => {
    expect(
      paidPlanBadge(capabilitiesView(null, stored({ workersPlan: { state: "free" } }))),
    ).toEqual({ met: false, label: "Detected: Workers Free" });
    expect(paidPlanBadge(capabilitiesView("paid", null))).toEqual({
      met: true,
      label: "Set by you: Workers Paid",
    });
    expect(paidPlanBadge(capabilitiesView("free", null))).toBeNull();
    expect(paidPlanBadge(capabilitiesView(null, null))).toBeNull();
  });
});

describe("capabilitiesView", () => {
  it("carries the probes, the plan in force, and the admin's own choice", () => {
    expect(capabilitiesView("free", stored({ workersPlan: { state: "paid" } }), "acc1")).toEqual({
      checkedAt: "2026-09-24T10:00:00.000Z",
      r2: { state: "enabled" },
      containers: NO_PERMISSION,
      workersPlan: { state: "paid" },
      zone: null,
      emailRouting: null,
      workersDev: null,
      zeroTrust: null,
      analyticsEngine: null,
      plan: { plan: "paid", source: "detected" },
      manualPlan: "free",
      accountId: "acc1",
    });
    expect(capabilitiesView(undefined, null)).toMatchObject({
      checkedAt: null,
      r2: null,
      plan: { plan: "free", source: "default" },
      manualPlan: null,
      accountId: null,
    });
  });
});

describe("unknownSentence", () => {
  it("names the missing permission, or the failure", () => {
    expect(unknownSentence(NO_PERMISSION, "plan")).toContain('"Billing: Read"');
    expect(
      unknownSentence({ ...NO_PERMISSION, reason: "error", detail: "fetch failed" }, "r2"),
    ).toBe("The check failed: fetch failed");
  });
});

describe("the manual Workers plan choice", () => {
  it("is hidden while the plan is detected, from the subscriptions or from Containers", () => {
    for (const probes of [
      stored({ workersPlan: { state: "paid" } }),
      stored({ workersPlan: { state: "free" } }),
      stored({ containers: { state: "available" } }),
    ]) {
      expect(manualPlanControl(capabilitiesView("free", probes))).toEqual({ show: false });
      expect(manualPlanControl(capabilitiesView(null, probes))).toEqual({ show: false });
    }
  });

  it("shows with the Billing: Read hint when the token cannot read the subscriptions", () => {
    expect(manualPlanControl(capabilitiesView(null, stored()))).toEqual({
      show: true,
      billingHint: true,
    });
    expect(manualPlanControl(capabilitiesView("paid", stored()))).toEqual({
      show: true,
      billingHint: true,
    });
  });

  it("shows with the hint before the first check", () => {
    expect(manualPlanControl(capabilitiesView(null, null))).toEqual({
      show: true,
      billingHint: true,
    });
  });

  it("shows without the hint when Billing: Read would not help", () => {
    for (const reason of ["unrecognised", "error"] as const) {
      const probes = stored({ workersPlan: { ...NO_PERMISSION, reason } });
      expect(manualPlanControl(capabilitiesView(null, probes)), reason).toEqual({
        show: true,
        billingHint: false,
      });
    }
  });
});
