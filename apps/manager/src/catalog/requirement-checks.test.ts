import { describe, expect, it } from "vitest";
import { capabilitiesView } from "../capabilities/capabilities";
import { requirementChecks } from "./requirement-checks";
import { requirementLabel } from "./requirements";

const probed = capabilitiesView(null, {
  checkedAt: "2026-09-24T12:00:00.000Z",
  r2: { state: "enabled" },
  containers: { state: "needs-workers-paid" },
  workersPlan: { state: "free" },
});

describe("requirementChecks", () => {
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
