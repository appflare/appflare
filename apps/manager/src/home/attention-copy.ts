import type { AttentionItem, FailedJob } from "./attention";

/**
 * The words of each "Needs attention" row: a title that says what happened
 * to what, and one line on why it matters or what to do. Written for people
 * who own the account, not for developers: no Worker names, ids or codes.
 */

/** What a failed job was doing, as the start of a sentence about the app. */
export function failedJobTitle(job: FailedJob, label: string): string {
  if (job.kind === "rollback" && job.restore)
    return `Restoring the database of ${label} did not finish`;
  if (job.kind === "uninstall" && job.deleteRetained) {
    return `Deleting the kept data of ${label} did not finish`;
  }
  switch (job.kind) {
    case "install":
      return `Installing ${label} did not finish`;
    case "update":
      return job.version === null
        ? `Updating ${label} did not finish`
        : `Updating ${label} to ${job.version} did not finish`;
    case "uninstall":
      return `Removing ${label} did not finish`;
    case "rollback":
      return `Rolling back ${label} did not finish`;
    case "reconfigure":
      return `Saving the settings of ${label} did not finish`;
    default:
      return `A change to ${label} did not finish`;
  }
}

/** What happens next after a failed job, in one line. */
function failedJobLine(job: FailedJob): string {
  switch (job.kind) {
    case "update":
    case "reconfigure":
    case "rollback":
      return "The app keeps running as it was. The log shows the step that failed and why.";
    default:
      return "The log shows the step that failed and why.";
  }
}

export function attentionCopy(item: AttentionItem): { title: string; description: string } {
  switch (item.kind) {
    case "failed-job":
      return { title: failedJobTitle(item.job, item.label), description: failedJobLine(item.job) };
    case "not-responding":
      return {
        title: `${item.label} is not responding`,
        description:
          item.health === "unhealthy"
            ? "It answered its last check with an error."
            : "It did not answer its last check. It may still have been starting up.",
      };
    case "update":
      return {
        title: `${item.label} ${item.latestVersion} is available`,
        description:
          item.needs === null
            ? `You have ${item.version}.`
            : `You have ${item.version}. ${item.needs}`,
      };
    case "account":
      return {
        title: item.row.name,
        description: item.row.found === null ? item.row.why : `${item.row.found}. ${item.row.why}`,
      };
    case "deploy-copy":
      return {
        title: "Clean up the deploy copy",
        description:
          "The Deploy to Cloudflare button left a copy of Appflare connected to this account. A push to it would put that older Appflare back.",
      };
    case "downgrade":
      return {
        title: `This Appflare (${item.downgrade.version}) is older than its database`,
        description: `A newer version set up this database, and an older one now runs${
          item.downgrade.deployButton ? ", perhaps after a push to the deploy copy" : ""
        }. Appflare keeps working, but what the newer version added is missing until you update again.`,
      };
  }
}
