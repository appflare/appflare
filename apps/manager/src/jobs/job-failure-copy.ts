import { jobKindLabel } from "../components/format";
import { failedJobTitle } from "../home/attention-copy";

/**
 * What a failed job's page says first: a plain sentence about what did not
 * finish, and at most one line on what that means. The job's own error
 * (the step that stopped and Cloudflare's answer) is technical detail, shown
 * on request. Client-safe.
 */

/** What the page knows of a failed job. */
export interface FailedJobView {
  kind: string;
  restore?: boolean;
  deleteRetained?: boolean;
  /** The Appflare version a self-update or rollback moved to. */
  targetVersion?: string | null;
  install: { label: string } | null;
  error: string | null;
}

/** Jobs of Appflare itself, by kind, as the start of the headline. */
const OWN_JOBS: Record<string, string> = {
  self_rollback: "Rolling Appflare back",
  sandbox_enable: "Turning on sandbox builds",
  sandbox_update: "Updating sandbox builds",
  sandbox_disable: "Turning off sandbox builds",
  source_build: "Building for review",
  move_address: "Moving Appflare to its new address",
};

/** "Installing Short links did not finish." */
export function jobFailureHeadline(job: FailedJobView): string {
  if (job.install !== null) {
    return `${failedJobTitle(
      {
        kind: job.kind,
        restore: job.restore === true,
        deleteRetained: job.deleteRetained === true,
        version: null,
      },
      job.install.label,
    )}.`;
  }
  if (job.kind === "self_update") {
    return job.targetVersion
      ? `Updating Appflare to ${job.targetVersion} did not finish.`
      : "Updating Appflare did not finish.";
  }
  const doing = OWN_JOBS[job.kind];
  return doing === undefined ? `${jobKindLabel(job)} did not finish.` : `${doing} did not finish.`;
}

/**
 * Why, when the error says so in a way that needs no reading of it:
 * Cloudflare refusing Appflare's credentials, or a permission.
 */
function plainCause(error: string | null): string | null {
  if (error === null) return null;
  if (/->\s*401\b/.test(error)) return "Cloudflare did not accept Appflare's access.";
  if (/->\s*403\b/.test(error)) return "Cloudflare refused a permission Appflare needs.";
  return null;
}

/** What stays as it was after a job of this kind failed; null when nothing needs saying. */
function whatStays(job: FailedJobView): string | null {
  if (job.install !== null) {
    return job.kind === "update" || job.kind === "reconfigure" || job.kind === "rollback"
      ? "The app keeps running as it was."
      : null;
  }
  if (job.kind === "self_update" || job.kind === "self_rollback") {
    return "Appflare keeps running the version it had.";
  }
  if (job.kind === "move_address") return "Appflare stays at its current address.";
  return null;
}

/** The one line under the headline; null when there is nothing plain to add. */
export function jobFailureLine(job: FailedJobView): string | null {
  const parts = [plainCause(job.error), whatStays(job)].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(" ");
}
