import { dashboardUrl } from "../cloudflare/dashboard-links";
import { COLOR_MODE_SCRIPT, COLOR_MODE_SCRIPT_SHA256 } from "../components/color-mode";
import { plainMessage } from "../components/message-links";
import { settingsLink } from "../components/settings-links";
import type { RemovalStep } from "./removal.server";

/**
 * The static pages the danger-zone actions answer with. Each is complete in
 * itself: styles inline, no images, nothing loaded from the manager, because
 * the removal page must still render after the manager Worker has deleted
 * itself. The one script is the manager's inline colour-mode script, allowed
 * by its hash, so the page is light unless the account menu's Appearance
 * says otherwise. Every value is HTML-escaped.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root { color-scheme: light; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --bg: #ffffff; --card: #f6f8fa; --ok: #1a7f37; --bad: #cf222e; --skip: #59636e; --link: #0969da; }
:root[data-mode="dark"] { color-scheme: dark; --fg: #f0f6fc; --muted: #9198a1; --line: #3d444d; --bg: #0d1117; --card: #151b23; --ok: #3fb950; --bad: #f85149; --skip: #9198a1; --link: #4493f8; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
h1 { font-size: 1.5rem; line-height: 1.3; margin: 0 0 .75rem; }
h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
p { margin: .5rem 0; }
.muted { color: var(--muted); }
a { color: var(--link); }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; }
ol.steps { list-style: none; margin: 1.25rem 0 0; padding: 0; border: 1px solid var(--line); border-radius: .5rem; background: var(--card); }
ol.steps li { display: grid; grid-template-columns: 5.5rem 1fr; gap: .75rem; padding: .6rem .9rem; border-top: 1px solid var(--line); }
ol.steps li:first-child { border-top: 0; }
.status { font-weight: 600; font-size: .85rem; text-transform: uppercase; letter-spacing: .03em; }
.done { color: var(--ok); } .failed { color: var(--bad); } .skipped { color: var(--skip); }
.box { margin-top: 1.5rem; padding: 1rem 1.1rem; border: 1px solid var(--line); border-radius: .5rem; }
.box.bad { border-color: var(--bad); }
ul { margin: .5rem 0; padding-left: 1.25rem; }
`;

function head(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
<script>${COLOR_MODE_SCRIPT}</script>
</head>
<body>
<main>
`;
}

const TAIL = "</main>\n</body>\n</html>\n";

export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Nothing on these pages loads anything: no images, no requests back, and no
  // script but the inline colour-mode one, allowed by its hash.
  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${COLOR_MODE_SCRIPT_SHA256}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
} as const;

/** A refused or failed action, with the way back. */
export function errorPage(title: string, message: string): string {
  return `${head(title)}<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(plainMessage(message))}</p>
<p><a href="${settingsLink("account")}">Back to Settings</a></p>
${TAIL}`;
}

/** The result of rotating the auth secret. */
export function rotationPage(result: { rotatedAt: string; channels: number }): string {
  const when = new Date(result.rotatedAt).toUTCString();
  const channels =
    result.channels === 0
      ? "<p>No notification channel is set up, so there are no credentials to enter again.</p>"
      : `<p>The credentials of ${result.channels === 1 ? "your notification channel" : `your ${result.channels} notification channels`} were encrypted with a key derived from the old secret and can no longer be read. The <a href="${settingsLink("notifications", "channels")}">notification settings</a> show ${result.channels === 1 ? "it" : "them"} as <strong>Credentials unreadable</strong>: edit ${result.channels === 1 ? "it" : "each one"} and enter the bot token or webhook URL again. Until then Appflare sends nothing there.</p>`;
  return `${head("Auth secret rotated")}<h1>The auth secret was rotated</h1>
<p class="muted">Rotated on ${escapeHtml(when)}.</p>
<p>Appflare now runs with a new <code>BETTER_AUTH_SECRET</code>. Everyone is signed out, you included: every session ended, and cookies signed with the old secret no longer work. Passwords and passkeys are unchanged.</p>
<h2>Notification channels</h2>
${channels}
<p><a href="/login">Sign in again</a></p>
${TAIL}`;
}

/** The start of the removal page, sent before the first step runs. */
export function removalPageStart(info: { accountName: string; workerName: string }): string {
  return `${head("Removing Appflare")}<h1>Removing Appflare from ${escapeHtml(info.accountName)}</h1>
<p class="muted">Each step shows here as it finishes; the manager Worker <code>${escapeHtml(info.workerName)}</code> goes last. Keep this page open until the summary appears at the end.</p>
<ol class="steps">
`;
}

export function removalStepLine(step: RemovalStep): string {
  const status = { done: "Done", skipped: "Skipped", failed: "Failed" }[step.status];
  return `<li><span class="status ${step.status}">${status}</span><span><strong>${escapeHtml(step.label)}</strong><br><span class="muted">${escapeHtml(step.detail)}</span></span></li>
`;
}

/** Where the installer and its instructions are documented. */
export const INSTALL_DOCS_URL = "https://appflare-docs.appflare-dev.workers.dev/start/install/";

export interface RemovalSummary {
  outcome: "complete" | "failed";
  accountId: string;
  workerName: string;
  /**
   * The sandbox Worker's container applications could not be seen (the
   * token lacks Containers), so they may remain and must be deleted by hand.
   */
  containersLeft: boolean;
  /** Cloudflare Access protection was on when the removal started. */
  accessOn: boolean;
  /** Access applications the removal could not delete (complete removals only). */
  accessLeft: string[];
}

function accessStatus(summary: RemovalSummary): string {
  if (!summary.accessOn) {
    return "<p>Cloudflare Access protection was off; there was nothing to remove there.</p>";
  }
  if (summary.outcome === "failed") {
    return "<p>Cloudflare Access protection is still on: its applications are removed last, so the manager stays protected until everything else is gone.</p>";
  }
  if (summary.accessLeft.length === 0) {
    return "<p>The Cloudflare Access applications that protected the manager are deleted.</p>";
  }
  return `<p>These Cloudflare Access applications could not be deleted: ${summary.accessLeft.map((id) => `<code>${escapeHtml(id)}</code>`).join(", ")}. Delete them under Zero Trust, Access, Applications, or they keep asking for a sign-in on the manager's address.</p>`;
}

/** The end of the removal page: what happens next, and what stayed. */
export function removalPageEnd(summary: RemovalSummary): string {
  const dashboard = dashboardUrl(summary.accountId, "workers-and-pages");
  const tokens = dashboardUrl(summary.accountId, "api-tokens");
  const worker = escapeHtml(summary.workerName);
  if (summary.outcome === "failed") {
    return `</ol>
<div class="box bad">
<h2>The removal stopped</h2>
<p>What was deleted stays deleted. The manager Worker <code>${worker}</code>, its database and everything after the failed step are still in the account, so Appflare keeps working and jobs can start again.</p>
${accessStatus(summary)}
<p>Fix the cause if the message names one, then run <strong>Remove Appflare from this account</strong> again from the <a href="${settingsLink("account", "danger-zone")}">danger zone</a>. Steps that are already done are skipped.</p>
</div>
${TAIL}`;
  }
  const containers = summary.containersLeft
    ? `<p>Appflare's token cannot use Containers, so the sandbox Worker's container applications were not deleted. If they are still listed under Workers, Containers in the dashboard, delete them there.</p>`
    : "";
  return `</ol>
<div class="box">
<h2>Last step: the manager Worker</h2>
<p>Now that this page has been sent, the Worker <code>${worker}</code> deletes itself, with its Workflow, its cron trigger and its workers.dev address. That takes a few seconds. This page is all that is left of Appflare; there is nothing to reload.</p>
<p>If <code>${worker}</code> is still listed in the <a href="${escapeHtml(dashboard)}" rel="noreferrer">Cloudflare dashboard</a> in a minute, delete it there.</p>
${accessStatus(summary)}
${containers}</div>
<h2>Revoke the Appflare API token</h2>
<p>The Cloudflare API token you created for Appflare still works. Nothing uses it any more: revoke it under <a href="${escapeHtml(tokens)}" rel="noreferrer">Account API tokens</a> (or under My Profile, API Tokens if you created a user token), together with any tokens you created for apps that you no longer need.</p>
<h2>What stays</h2>
<ul>
<li>Every app Appflare installed, with its Worker, databases, buckets, namespaces and secrets. They keep running, unmanaged: nothing updates them any more.</li>
<li>Custom domains of apps, which keep serving them.</li>
</ul>
<p>To manage the apps again, reinstall Appflare with the installer from the repository, as <a href="${INSTALL_DOCS_URL}" rel="noreferrer">the install guide</a> describes. It starts empty and does not know the apps already in the account.</p>
${TAIL}`;
}
