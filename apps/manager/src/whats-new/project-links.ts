/**
 * Where the account menu's outside links go: the repository (to star it)
 * and a new issue for feedback. Client-safe.
 */

export const REPOSITORY_URL = "https://github.com/appflare/appflare";

/** Prefix of a feedback issue's title; the person finishes the sentence. */
export const FEEDBACK_TITLE_PREFIX = "Feedback: ";

/**
 * A new-issue form on the repository, prefilled with a short template and
 * the running version. Nothing else about the manager or the person goes in
 * the URL: no account, email, hostname or app names.
 */
export function feedbackIssueUrl(version: string): string {
  const body = [
    "**What would you like to tell us?**",
    "",
    "",
    "",
    "**What did you expect, or what would help?**",
    "",
    "",
    "",
    "---",
    `Appflare ${version}`,
  ].join("\n");
  const params = new URLSearchParams({ title: FEEDBACK_TITLE_PREFIX, body });
  return `${REPOSITORY_URL}/issues/new?${params.toString()}`;
}
