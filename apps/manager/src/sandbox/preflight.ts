import type { ContainersCapability, R2Capability } from "@appflare/cf-api/capabilities";

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

const R2_DASHBOARD_URL = "https://dash.cloudflare.com/?to=/:account/r2/overview";
const PLANS_URL = "https://dash.cloudflare.com/?to=/:account/workers/plans";

export const NEEDS_WORKERS_PAID_REASON = `Sandbox builds need Workers Paid: the builds run in Cloudflare Containers, which the free plan does not include. Upgrade the account at ${PLANS_URL}.`;

export const R2_NOT_ENABLED_REASON = `R2 is not enabled on this account. The sandbox Worker keeps build outputs in an R2 bucket: open R2 in the Cloudflare dashboard once to enable it (${R2_DASHBOARD_URL}).`;

export const NO_CONTAINERS_PERMISSION_REASON =
  "Appflare's API token lacks Containers: Edit, which creates, updates and deletes the sandbox Worker's container applications. Edit the token in the Cloudflare dashboard (editing keeps its value), add Account > Containers > Edit, then check again.";

export const NO_R2_PERMISSION_REASON =
  "Appflare's API token cannot use R2 (Workers R2 Storage: Edit), which creates and deletes the build bucket.";

/**
 * The reasons, one sentence each; empty when nothing is known to block.
 * `containersOnly` checks just what disabling needs (the applications).
 */
export function sandboxPreflightProblems(
  probes: { r2: R2Capability | null; containers: ContainersCapability | null },
  opts: { containersOnly?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const { r2, containers } = probes;
  if (containers?.state === "needs-workers-paid") problems.push(NEEDS_WORKERS_PAID_REASON);
  if (containers?.state === "unknown" && containers.reason === "no-permission") {
    problems.push(NO_CONTAINERS_PERMISSION_REASON);
  }
  if (opts.containersOnly) return problems;
  if (r2?.state === "not-enabled") problems.push(R2_NOT_ENABLED_REASON);
  if (r2?.state === "unknown" && r2.reason === "no-permission") {
    problems.push(NO_R2_PERMISSION_REASON);
  }
  return problems;
}
