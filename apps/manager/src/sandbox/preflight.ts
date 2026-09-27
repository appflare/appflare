import type { ContainersCapability, R2Capability } from "@appflare/cf-api/capabilities";
import { dashboardUrl } from "../cloudflare/dashboard-links";

/**
 * Why sandbox builds cannot be enabled (or updated, or disabled) with this
 * account and token, from the capability probes. Client-safe: the Settings
 * card words a stored probe result the same way the server refuses a live one.
 *
 * Enabling needs Workers Paid (Containers exist only there), R2 enabled once
 * in the dashboard (the build bucket), and Containers: Edit on the token (the
 * container applications). A probe that could not tell for another reason
 * (a network error, an answer the probe does not know) blocks nothing: the
 * job's own first step asks again.
 */

/** Why sandbox builds need Workers Paid, with the account's plans page (null: not known yet). */
export function needsWorkersPaidReason(accountId: string | null): string {
  return `Sandbox builds need Workers Paid: the builds run in Cloudflare Containers, which the free plan does not include. Upgrade the account at ${dashboardUrl(accountId, "workers/plans")}.`;
}

/** Why sandbox builds need R2 turned on, with the account's R2 page (null: not known yet). */
export function r2NotEnabledReason(accountId: string | null): string {
  return `R2 is not enabled on this account. The sandbox Worker keeps build outputs in an R2 bucket: open R2 in the Cloudflare dashboard once to enable it (${dashboardUrl(accountId, "r2/overview")}).`;
}

export const NO_CONTAINERS_PERMISSION_REASON =
  "Appflare's API token lacks Containers: Edit, which creates, updates and deletes the sandbox Worker's container applications. Edit the token in the Cloudflare dashboard (editing keeps its value), add Account > Containers > Edit, then check again.";

export const NO_R2_PERMISSION_REASON =
  "Appflare's API token cannot use R2 (Workers R2 Storage: Edit), which creates and deletes the build bucket.";

/**
 * The reasons, one sentence each; empty when nothing is known to block.
 * `containersOnly` checks just what disabling needs (the applications).
 * `accountId` is the account the dashboard links open (null: not known yet).
 */
export function sandboxPreflightProblems(
  probes: {
    r2: R2Capability | null;
    containers: ContainersCapability | null;
    accountId: string | null;
  },
  opts: { containersOnly?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const { r2, containers, accountId } = probes;
  if (containers?.state === "needs-workers-paid") problems.push(needsWorkersPaidReason(accountId));
  if (containers?.state === "unknown" && containers.reason === "no-permission") {
    problems.push(NO_CONTAINERS_PERMISSION_REASON);
  }
  if (opts.containersOnly) return problems;
  if (r2?.state === "not-enabled") problems.push(r2NotEnabledReason(accountId));
  if (r2?.state === "unknown" && r2.reason === "no-permission") {
    problems.push(NO_R2_PERMISSION_REASON);
  }
  return problems;
}
