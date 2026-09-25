import type { ContainersCapability, R2Capability } from "@appflare/cf-api/capabilities";
import type { AccountPlan } from "../account/plan";
import type { CapabilitiesView } from "../capabilities/capabilities";
import {
  NEEDS_WORKERS_PAID_REASON,
  NO_CONTAINERS_PERMISSION_REASON,
  NO_R2_PERMISSION_REASON,
  R2_NOT_ENABLED_REASON,
} from "./preflight";

/**
 * Whether sandbox builds are on, and if not, whether Appflare can turn them
 * on by itself the first time something needs them (an install of an app
 * built in the account or deployed by its own installer, or a build from a
 * repository). Client-safe: the account checklist, the app page and the
 * repository dialog read the same words, and the install start applies the
 * same rules to live probes.
 *
 * - `on`: this manager has its `SANDBOX` binding.
 * - `ready-auto`: Workers Paid, R2 enabled and the token's Containers: Edit
 *   are in place; the first install or build that needs the sandbox turns
 *   sandbox builds on first.
 * - `needs-plan`: the account is not on Workers Paid (Containers exist only there).
 * - `needs-permission`: the token lacks Containers: Edit (or R2 access).
 * - `needs-r2`: R2 has not been enabled on the account.
 */

export type SandboxRowState = "on" | "ready-auto" | "needs-plan" | "needs-permission" | "needs-r2";

export interface SandboxReadiness {
  state: SandboxRowState;
  /** What is missing and where to fix it; null for `on` and `ready-auto`. */
  missing: string | null;
  /**
   * For `ready-auto`: the stored probes confirmed Containers and R2. False
   * when one has not run yet or could not tell; the start asks again.
   */
  confirmed: boolean;
}

/** The id of the sandbox builds row in the account checklist, for links to it. */
export const SANDBOX_CHECKLIST_ROW_ID = "checklist-sandbox";

/** The account checklist's sandbox builds row (Settings, Account and capabilities). */
export const SANDBOX_CHECKLIST_HREF = `/settings/account#${SANDBOX_CHECKLIST_ROW_ID}`;

/** The line an install or build confirmation adds when it turns sandbox builds on first. */
export const SANDBOX_FIRST_NOTE = "Sandbox builds will be turned on first (about two minutes).";

export interface SandboxReadinessInput {
  /** The running Worker has its `SANDBOX` binding. */
  connected: boolean;
  r2: R2Capability | null;
  containers: ContainersCapability | null;
  /** The Workers plan in force (detected, else set by an admin, else free). */
  plan: AccountPlan;
}

export function sandboxReadiness(input: SandboxReadinessInput): SandboxReadiness {
  const { connected, r2, containers, plan } = input;
  if (connected) return { state: "on", missing: null, confirmed: true };
  const needs = (state: SandboxRowState, missing: string): SandboxReadiness => ({
    state,
    missing,
    confirmed: true,
  });
  // Containers answering "requires Workers Paid" settles the plan; Containers
  // available proves Workers Paid even when no plan is detected.
  if (containers?.state === "needs-workers-paid") {
    return needs("needs-plan", NEEDS_WORKERS_PAID_REASON);
  }
  const noContainersPermission =
    containers?.state === "unknown" && containers.reason === "no-permission";
  if (containers?.state !== "available" && plan !== "paid") {
    // Without Containers: Edit the token cannot tell the plan either.
    return needs(
      "needs-plan",
      noContainersPermission
        ? `${NEEDS_WORKERS_PAID_REASON} If it already is: ${NO_CONTAINERS_PERMISSION_REASON}`
        : NEEDS_WORKERS_PAID_REASON,
    );
  }
  if (noContainersPermission) {
    return needs("needs-permission", NO_CONTAINERS_PERMISSION_REASON);
  }
  if (r2?.state === "not-enabled") return needs("needs-r2", R2_NOT_ENABLED_REASON);
  if (r2?.state === "unknown" && r2.reason === "no-permission") {
    return needs("needs-permission", NO_R2_PERMISSION_REASON);
  }
  // A probe that has not run or could not tell blocks nothing, as when
  // enabling from Settings: the enable job's first step asks again.
  return {
    state: "ready-auto",
    missing: null,
    confirmed: containers?.state === "available" && r2?.state === "enabled",
  };
}

/** From the stored capabilities, as the checklist and the app page show it. */
export function sandboxReadinessOf(view: CapabilitiesView, connected: boolean): SandboxReadiness {
  return sandboxReadiness({
    connected,
    r2: view.r2,
    containers: view.containers,
    plan: view.plan.plan,
  });
}
