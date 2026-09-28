import { DOCS_URL } from "./components/auth-layout";

/**
 * The pages (and sections) of the public docs that the manager links to
 * where people get stuck. Each value is a page's path on the docs site,
 * without slashes around it, optionally followed by `#` and the id of one of
 * its headings. `docs-topics.test.ts` checks every one against the docs
 * content, so a moved page or a renamed heading fails the tests.
 */
export const DOCS_TOPICS = {
  tokenPermissions: "start/install#1-connect-cloudflare",
  capabilities: "start/install#3-check-your-account",
  requirements: "guides/catalog#requirements",
  customCatalogs: "guides/custom-catalogs#add-a-catalog",
  customDomains: "guides/custom-domains",
  externalDomains: "guides/external-domains#add-a-domain-to-an-app",
  gateway: "guides/external-domains#what-you-need",
  sandboxBuilds: "guides/builds",
  usageData: "telemetry#turning-it-off",
  notificationChannels: "guides/notifications#add-a-channel",
  webhookSignature: "guides/notifications#verify-the-signature",
  automaticUpdates: "guides/updates#automatic-updates",
  appflareAutomaticUpdates: "guides/update-appflare#update-automatically",
  settingsChange: "guides/settings#what-the-job-does",
  settingsChangeBuilt: "guides/settings#apps-built-in-your-account",
  removedApps: "guides/uninstall#removed-apps",
  installJob: "guides/install-apps#what-the-install-job-does",
  updateJob: "guides/updates#update-an-app",
  uninstallJob: "guides/uninstall#if-an-uninstall-stops",
  rollbackJob: "guides/updates#roll-back",
  databaseRestore: "guides/updates#restore-a-database-to-a-bookmark",
  appflareUpdateJob: "guides/update-appflare#update-from-settings",
  appflareRollback: "guides/update-appflare#roll-back",
  deployCopyCleanup: "start/deploy-button#clean-up-the-deploy-copy",
  installFromRepository: "guides/install-from-a-repository",
  sourceBuildReview: "guides/install-from-a-repository#review-the-build",
  sourceBuildJob: "guides/install-from-a-repository#if-the-build-fails",
  repositoryUpdates: "guides/install-from-a-repository#check-for-changes",
  githubAccess: "guides/install-from-a-repository#private-repositories",
  forgotPassword: "guides/forgot-password",
  passwordResetEmails: "guides/forgot-password#turn-on-password-reset-emails",
  accessLockedOut: "security#if-you-are-locked-out",
} as const satisfies Record<string, string>;

export type DocsTopic = keyof typeof DOCS_TOPICS;

/** The absolute URL of a topic on the docs site, with the site's trailing slash. */
export function docsUrl(topic: DocsTopic): string {
  const [path = "", anchor] = DOCS_TOPICS[topic].split("#");
  const page = path === "" ? DOCS_URL : `${DOCS_URL}${path}/`;
  return anchor === undefined ? page : `${page}#${anchor}`;
}

/**
 * Where a failed job's kind is explained, with what to do next. A database
 * restore is recorded as a rollback and deleting the data an uninstall kept
 * as an uninstall; each carries a flag.
 */
export function jobFailureTopic(job: {
  kind: string;
  restore?: boolean;
  deleteRetained?: boolean;
}): DocsTopic | null {
  if (job.restore === true) return "databaseRestore";
  if (job.deleteRetained === true) return "removedApps";
  switch (job.kind) {
    case "install":
      return "installJob";
    case "update":
      return "updateJob";
    case "uninstall":
      return "uninstallJob";
    case "rollback":
      return "rollbackJob";
    case "self_update":
      return "appflareUpdateJob";
    case "self_rollback":
      return "appflareRollback";
    case "reconfigure":
      return "settingsChange";
    case "sandbox_enable":
    case "sandbox_update":
    case "sandbox_disable":
      return "sandboxBuilds";
    case "source_build":
      return "sourceBuildJob";
    default:
      return null;
  }
}
