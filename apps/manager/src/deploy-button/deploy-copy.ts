/**
 * Managers deployed with the "Deploy to Cloudflare" button. The button copies
 * the public `appflare/deploy` repository into the visitor's GitHub or GitLab
 * account and connects that copy to the new Worker with Workers Builds. Both
 * stay behind after the deploy, and Appflare needs neither: it updates itself
 * from signed releases. Worse, a push to the copy rebuilds it and deploys the
 * old version it holds over whatever Appflare has updated itself to. Appflare
 * cannot remove either (the Workers Builds API refuses the account-owned
 * token it holds), so the home page asks an admin to, once per manager.
 *
 * The deploy repository's `wrangler.jsonc` sets `APPFLARE_INSTALL_SOURCE` to
 * `deploy-button`. Self-updates copy plain-text variables from the running
 * Worker, so the marker survives them.
 */

/** `APPFLARE_INSTALL_SOURCE` of a manager deployed with the button. */
export const INSTALL_SOURCE_DEPLOY_BUTTON = "deploy-button";

/** Whether this manager was deployed with the "Deploy to Cloudflare" button. */
export function deployButtonInstalled(env: { APPFLARE_INSTALL_SOURCE?: string }): boolean {
  return env.APPFLARE_INSTALL_SOURCE?.trim() === INSTALL_SOURCE_DEPLOY_BUTTON;
}

/**
 * The Worker's settings page in the Cloudflare dashboard, where Settings,
 * Builds, Disconnect removes the Workers Builds connection. Without the
 * account id or the Worker name (before the token step recorded them), the
 * account's Workers & Pages list, where the Worker is one click away.
 */
export function workerSettingsUrl(accountId: string | null, workerName: string | null): string {
  if (accountId === null || workerName === null) {
    return "https://dash.cloudflare.com/?to=/:account/workers-and-pages";
  }
  // Dashboard URL pattern unverified: taken from public references to the
  // Worker settings page, not opened with a dashboard session.
  return `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/workers/services/view/${encodeURIComponent(workerName)}/production/settings`;
}

/**
 * Where to find the copy on GitHub. Its owner and name are not known: the
 * visitor picks the account or organization, and the name defaults to the
 * project name, which is also the Worker's name. The button makes the copy
 * private unless the visitor unticks that, and a search limited to private
 * repositories lists only ones the visitor can see, across their account and
 * organizations, so the list is short.
 */
export function deployCopySearchUrl(workerName: string | null): string {
  const query = `${workerName ?? "appflare"} in:name is:private`;
  return `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`;
}

/** What the home page's "Clean up the deploy copy" card shows. */
export interface DeployCopyCleanup {
  workerName: string | null;
  workerSettingsUrl: string;
  repositorySearchUrl: string;
}

/**
 * The card's content, or null when it is not shown: the manager was not
 * deployed with the button, an admin already dismissed the card, or the
 * viewer is not an admin (members cannot dismiss it, and the cleanup needs
 * someone who administers the account anyway).
 */
export function deployCopyCleanup(input: {
  installSource: string | undefined;
  dismissedAt: string | undefined;
  isAdmin: boolean;
  accountId: string | undefined;
  workerName: string | undefined;
}): DeployCopyCleanup | null {
  if (!deployButtonInstalled({ APPFLARE_INSTALL_SOURCE: input.installSource })) return null;
  if (input.dismissedAt !== undefined || !input.isAdmin) return null;
  const workerName = input.workerName ?? null;
  return {
    workerName,
    workerSettingsUrl: workerSettingsUrl(input.accountId ?? null, workerName),
    repositorySearchUrl: deployCopySearchUrl(workerName),
  };
}
