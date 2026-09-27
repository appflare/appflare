import type { ContainersCapability, R2Capability } from "@appflare/cf-api/capabilities";
import type { AccountPlan } from "../account/plan";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { settingsLink } from "../components/settings-links";
import {
  NO_CONTAINERS_PERMISSION_REASON,
  NO_R2_PERMISSION_REASON,
  needsWorkersPaidReason,
  r2NotEnabledReason,
} from "./preflight";

/**
 * Whether sandbox builds are on, and if not, whether Appflare can turn them
 * on by itself the first time something needs them (an install of an app
 * built in the account or deployed by its own installer, or a build from a
 * repository). Client-safe: Your account, the setup step, the app page and the
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
 * - `enabling`: a `sandbox_enable` job is queued or running (see
 *   {@link withSandboxJobs}); its id is `jobId`.
 */

export type SandboxRowState =
  | "on"
  | "ready-auto"
  | "needs-plan"
  | "needs-permission"
  | "needs-r2"
  | "enabling";

export interface SandboxReadiness {
  state: SandboxRowState;
  /** What is missing and where to fix it; null for `on` and `ready-auto`. */
  missing: string | null;
  /**
   * For `ready-auto`: the stored probes confirmed Containers and R2. False
   * when one has not run yet or could not tell; the start asks again.
   */
  confirmed: boolean;
  /** For `enabling`: the job turning sandbox builds on, for a link to its log. */
  jobId?: string;
  /**
   * The last enable that failed (and none has succeeded since), when
   * sandbox builds are not on and nothing is enabling them now.
   */
  failure?: SandboxEnableFailure;
}

/** A failed `sandbox_enable` job: its id and the first line that says why. */
export interface SandboxEnableFailure {
  id: string;
  message: string;
}

/** The sandbox jobs that change what the row says, read next to the probes. */
export interface SandboxJobState {
  /** A `sandbox_enable` job that is queued or running. */
  activeEnable: { id: string } | null;
  /** The most recent failed sandbox job, unless a newer one succeeded. */
  lastFailure: { id: string; kind: string; message: string } | null;
}

export const NO_SANDBOX_JOBS: SandboxJobState = { activeEnable: null, lastFailure: null };

/**
 * The probes' reading adjusted by the jobs: on stays on (the enable
 * succeeded); a queued or running enable is `enabling`; otherwise the
 * probes' state, with the last failed enable attached so the row can say so.
 */
export function withSandboxJobs(base: SandboxReadiness, jobs: SandboxJobState): SandboxReadiness {
  if (base.state === "on") return base;
  if (jobs.activeEnable !== null) {
    return { state: "enabling", missing: null, confirmed: true, jobId: jobs.activeEnable.id };
  }
  const failed = jobs.lastFailure;
  if (failed === null || failed.kind !== "sandbox_enable") return base;
  return { ...base, failure: { id: failed.id, message: failed.message } };
}

/** The sandbox builds row of "What this account can run" on Your account. */
export const SANDBOX_CAPABILITY_HREF = settingsLink("account", "capability-sandbox");

/** The line an install or build confirmation adds when it turns sandbox builds on first. */
export const SANDBOX_FIRST_NOTE = "Sandbox builds will be turned on first (about two minutes).";

export interface SandboxReadinessInput {
  /** The running Worker has its `SANDBOX` binding. */
  connected: boolean;
  r2: R2Capability | null;
  containers: ContainersCapability | null;
  /** The Workers plan in force (detected, else set by an admin, else free). */
  plan: AccountPlan;
  /** The account the dashboard links in `missing` open; null before a token is saved. */
  accountId: string | null;
}

export function sandboxReadiness(input: SandboxReadinessInput): SandboxReadiness {
  const { connected, r2, containers, plan, accountId } = input;
  const needsWorkersPaid = needsWorkersPaidReason(accountId);
  if (connected) return { state: "on", missing: null, confirmed: true };
  const needs = (state: SandboxRowState, missing: string): SandboxReadiness => ({
    state,
    missing,
    confirmed: true,
  });
  // Containers answering "requires Workers Paid" settles the plan; Containers
  // available proves Workers Paid even when no plan is detected.
  if (containers?.state === "needs-workers-paid") {
    return needs("needs-plan", needsWorkersPaid);
  }
  const noContainersPermission =
    containers?.state === "unknown" && containers.reason === "no-permission";
  if (containers?.state !== "available" && plan !== "paid") {
    // Without Containers: Edit the token cannot tell the plan either.
    return needs(
      "needs-plan",
      noContainersPermission
        ? `${needsWorkersPaid} If it already is: ${NO_CONTAINERS_PERMISSION_REASON}`
        : needsWorkersPaid,
    );
  }
  if (noContainersPermission) {
    return needs("needs-permission", NO_CONTAINERS_PERMISSION_REASON);
  }
  if (r2?.state === "not-enabled") return needs("needs-r2", r2NotEnabledReason(accountId));
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

/** From the stored capabilities, as Your account and the app page show it. */
export function sandboxReadinessOf(view: CapabilitiesView, connected: boolean): SandboxReadiness {
  return sandboxReadiness({
    connected,
    r2: view.r2,
    containers: view.containers,
    plan: view.plan.plan,
    accountId: view.accountId,
  });
}
