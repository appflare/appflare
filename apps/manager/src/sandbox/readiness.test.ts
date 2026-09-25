import type { ContainersCapability, R2Capability } from "@appflare/cf-api/capabilities";
import { describe, expect, it } from "vitest";
import { capabilitiesView } from "../capabilities/capabilities";
import {
  NEEDS_WORKERS_PAID_REASON,
  NO_CONTAINERS_PERMISSION_REASON,
  NO_R2_PERMISSION_REASON,
  R2_NOT_ENABLED_REASON,
} from "./preflight";
import { sandboxReadiness, sandboxReadinessOf } from "./readiness";

const enabled: R2Capability = { state: "enabled" };
const available: ContainersCapability = { state: "available" };
const noPermission = { state: "unknown", reason: "no-permission", detail: "403" } as const;
const failed = { state: "unknown", reason: "error", detail: "network" } as const;

describe("sandboxReadiness", () => {
  it("is on whenever the manager has its SANDBOX binding", () => {
    expect(sandboxReadiness({ connected: true, r2: null, containers: null, plan: "free" })).toEqual(
      { state: "on", missing: null, confirmed: true },
    );
  });

  it("is ready to turn on at first need with Workers Paid, R2 and Containers: Edit", () => {
    const r = sandboxReadiness({
      connected: false,
      r2: enabled,
      containers: available,
      plan: "free",
    });
    // Containers available proves Workers Paid even when no plan is detected.
    expect(r).toEqual({ state: "ready-auto", missing: null, confirmed: true });
  });

  it.each([
    [
      "Containers refuses for the plan",
      { r2: enabled, containers: { state: "needs-workers-paid" }, plan: "paid" },
      "needs-plan",
      NEEDS_WORKERS_PAID_REASON,
    ],
    [
      "the plan is free and Containers could not be checked",
      { r2: enabled, containers: noPermission, plan: "free" },
      "needs-plan",
      `${NEEDS_WORKERS_PAID_REASON} If it already is: ${NO_CONTAINERS_PERMISSION_REASON}`,
    ],
    [
      "the token lacks Containers: Edit",
      { r2: enabled, containers: noPermission, plan: "paid" },
      "needs-permission",
      NO_CONTAINERS_PERMISSION_REASON,
    ],
    [
      "R2 is not enabled",
      { r2: { state: "not-enabled" }, containers: available, plan: "paid" },
      "needs-r2",
      R2_NOT_ENABLED_REASON,
    ],
    [
      "the token cannot use R2",
      { r2: noPermission, containers: available, plan: "paid" },
      "needs-permission",
      NO_R2_PERMISSION_REASON,
    ],
  ] as const)("says what is missing when %s", (_what, probes, state, missing) => {
    const r = sandboxReadiness({ connected: false, ...probes });
    expect(r).toEqual({ state, missing, confirmed: true });
  });

  it("lets a probe that could not tell through on Workers Paid, unconfirmed", () => {
    expect(
      sandboxReadiness({ connected: false, r2: failed, containers: null, plan: "paid" }),
    ).toEqual({ state: "ready-auto", missing: null, confirmed: false });
  });

  it("reads the stored capabilities", () => {
    const view = capabilitiesView("paid", {
      checkedAt: "2026-09-25T00:00:00.000Z",
      r2: { state: "not-enabled" },
      containers: available,
      workersPlan: noPermission,
    });
    expect(sandboxReadinessOf(view, false).state).toBe("needs-r2");
    expect(sandboxReadinessOf(view, true).state).toBe("on");
    // Nothing probed yet and no plan known: Workers Free is assumed.
    expect(sandboxReadinessOf(capabilitiesView(null, null), false).state).toBe("needs-plan");
  });
});
