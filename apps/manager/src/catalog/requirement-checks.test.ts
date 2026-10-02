import { describe, expect, it } from "vitest";
import { capabilitiesView } from "../capabilities/capabilities";
import {
  analyticsEngineRefusal,
  requirementChecks,
  usesAnalyticsEngine,
} from "./requirement-checks";
import { requirementLabel } from "./requirements";

const probed = capabilitiesView(null, {
  checkedAt: "2026-09-24T12:00:00.000Z",
  r2: { state: "enabled" },
  containers: { state: "needs-workers-paid" },
  workersPlan: { state: "free" },
});

describe("requirementChecks", () => {
  it('leaves out an "access" the app needs only while protected', () => {
    const noZeroTrust = capabilitiesView(null, {
      checkedAt: "2026-09-24T12:00:00.000Z",
      r2: { state: "enabled" },
      containers: { state: "needs-workers-paid" },
      workersPlan: { state: "free" },
      zeroTrust: { state: "none" },
    });
    const conditional = requirementChecks(
      { plan: "free", requires: ["access"], accessIfProtected: true },
      noZeroTrust,
    );
    expect(conditional).toEqual({ met: [], pending: [] });
    const required = requirementChecks({ plan: "free", requires: ["access"] }, noZeroTrust);
    expect(required.pending.map((c) => [c.key, c.availability])).toEqual([
      ["access", "unavailable"],
    ]);
  });

  it("keeps what the account is known to offer out of the warning", () => {
    const checks = requirementChecks(
      { plan: "free", requires: ["r2", "workers-ai", "zone", "email-routing"] },
      probed,
    );
    expect(checks.met.map((c) => c.key)).toEqual(["r2", "workers-ai"]);
    expect(checks.pending.map((c) => [c.key, c.availability])).toEqual([
      ["zone", "unknown"],
      ["email-routing", "unknown"],
    ]);
  });

  it("meets zone and Email Routing requirements when the probes found them", () => {
    const withDomain = capabilitiesView(null, {
      checkedAt: "2026-09-24T12:00:00.000Z",
      r2: { state: "enabled" },
      containers: { state: "needs-workers-paid" },
      workersPlan: { state: "free" },
      zone: { state: "available" },
      emailRouting: { state: "available" },
    });
    const checks = requirementChecks(
      { plan: "free", requires: ["zone", "email-routing"] },
      withDomain,
    );
    expect(checks.pending).toEqual([]);
    expect(checks.met.map((c) => [c.key, c.label])).toEqual([
      ["zone", requirementLabel("zone")],
      ["email-routing", requirementLabel("email-routing")],
    ]);
  });

  it("keeps zone and Email Routing pending, as not available, when there is no domain", () => {
    const noDomain = capabilitiesView(null, {
      checkedAt: "2026-09-24T12:00:00.000Z",
      r2: { state: "enabled" },
      containers: { state: "needs-workers-paid" },
      workersPlan: { state: "free" },
      zone: { state: "none" },
      emailRouting: { state: "no-zone" },
    });
    const checks = requirementChecks(
      { plan: "free", requires: ["zone", "email-routing"] },
      noDomain,
    );
    expect(checks.met).toEqual([]);
    expect(checks.pending.map((c) => [c.key, c.availability])).toEqual([
      ["zone", "unavailable"],
      ["email-routing", "unavailable"],
    ]);
  });

  it("lists Workers Paid and Containers as not available on a detected Free account", () => {
    const checks = requirementChecks({ plan: "paid", requires: ["containers"] }, probed);
    expect(checks.met).toEqual([]);
    expect(checks.pending.map((c) => [c.label, c.availability])).toEqual([
      ["Workers Paid", "unavailable"],
      ["Containers", "unavailable"],
    ]);
  });

  it("has nothing to confirm when every requirement is detected", () => {
    const paid = capabilitiesView(null, {
      checkedAt: "2026-09-24T12:00:00.000Z",
      r2: { state: "enabled" },
      containers: { state: "available" },
      workersPlan: { state: "paid" },
    });
    const checks = requirementChecks({ plan: "paid", requires: ["r2", "containers"] }, paid);
    expect(checks.pending).toEqual([]);
    expect(checks.met.map((c) => c.label)).toEqual(["Workers Paid", "R2", "Containers"]);
  });

  it("keeps an unknown requirement for the admin to confirm", () => {
    const checks = requirementChecks({ plan: "free", requires: ["quantum"] }, probed);
    expect(checks.pending).toEqual([
      {
        key: "quantum",
        label: "quantum",
        availability: "unknown",
        reason: "Appflare does not know this requirement.",
      },
    ]);
  });
});

describe("Analytics Engine", () => {
  const off = { analyticsEngine: { state: "not-enabled" } } as const;

  it("is used by an app that asks for it, lists it as a service, or binds a dataset", () => {
    expect(usesAnalyticsEngine({ requires: ["analytics-engine"] })).toBe(true);
    expect(usesAnalyticsEngine({ requires: [], services: ["r2", "analytics-engine"] })).toBe(true);
    expect(usesAnalyticsEngine({ requires: [], bindings: [{ type: "analytics_engine" }] })).toBe(
      true,
    );
    expect(usesAnalyticsEngine({ requires: ["r2"], services: ["kv"], bindings: [] })).toBe(false);
  });

  it("refuses the install with the fix only when the probe found it off", () => {
    expect(analyticsEngineRefusal("Counterscale", { requires: ["analytics-engine"] }, off)).toBe(
      "Counterscale writes to Analytics Engine, which is not turned on for this account. Turn on Analytics Engine once in the dashboard, then choose Check again on Your account.",
    );
    expect(analyticsEngineRefusal("Cut", { requires: ["r2"] }, off)).toBeNull();
    for (const view of [
      null,
      {},
      { analyticsEngine: null },
      { analyticsEngine: { state: "enabled" } as const },
      { analyticsEngine: { state: "unknown", reason: "error", detail: "HTTP 500" } as const },
    ]) {
      expect(analyticsEngineRefusal("Sink", { requires: ["analytics-engine"] }, view)).toBeNull();
    }
  });

  it("puts the requirement in the warning with the fix while it is off", () => {
    const view = capabilitiesView(null, {
      checkedAt: "2026-09-24T12:00:00.000Z",
      r2: { state: "enabled" },
      containers: { state: "needs-workers-paid" },
      workersPlan: { state: "free" },
      analyticsEngine: { state: "not-enabled" },
    });
    const checks = requirementChecks({ plan: "free", requires: ["analytics-engine"] }, view);
    expect(checks.pending).toEqual([
      {
        key: "analytics-engine",
        label: "Analytics Engine",
        availability: "unavailable",
        reason: expect.stringContaining("then choose Check again"),
      },
    ]);
  });
});
