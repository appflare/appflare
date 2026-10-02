import { isMessageLinkPath } from "./internal-path";
import { messageLink } from "./message-links";

/**
 * Every part of an installed app's page another page, a message or a job
 * log points at: the page's tabs, and each section's element id with the tab
 * it is on and its heading. A link names the section only
 * (`/apps/<id>#secrets`); the page opens the tab that holds it, then scrolls
 * to it and rings it like any other link to a section. Client-safe and
 * server-safe (job logs are built from it too).
 */

/** The app page's tabs, in the order they show. */
export const APP_TABS = ["overview", "settings", "domains", "resources", "jobs"] as const;
export type AppTab = (typeof APP_TABS)[number];

export const APP_TAB_LABELS: Record<AppTab, string> = {
  overview: "Overview",
  settings: "Settings",
  domains: "Domains and email",
  resources: "Resources",
  jobs: "Jobs",
};

export const APP_SECTIONS = {
  details: { tab: "overview", title: "Details" },
  health: { tab: "overview", title: "Health" },
  source: { tab: "overview", title: "Source" },
  "next-steps": { tab: "overview", title: "Next steps" },
  "danger-zone": { tab: "overview", title: "Danger zone" },
  settings: { tab: "settings", title: "Settings" },
  secrets: { tab: "settings", title: "Secrets" },
  databases: { tab: "settings", title: "Databases" },
  "email-zone": { tab: "settings", title: "Email" },
  "automatic-updates": { tab: "settings", title: "Automatic updates" },
  "workers-dev": { tab: "domains", title: "workers.dev URL" },
  domains: { tab: "domains", title: "Custom domains" },
  "external-domains": { tab: "domains", title: "External domains" },
  access: { tab: "domains", title: "Cloudflare Access" },
  email: { tab: "domains", title: "Email" },
  resources: { tab: "resources", title: "Resources" },
  "kept-resources": { tab: "resources", title: "Kept in the account" },
  versions: { tab: "jobs", title: "Versions" },
  "job-history": { tab: "jobs", title: "Job history" },
} as const satisfies Record<string, { tab: AppTab; title: string }>;

export type AppSectionId = keyof typeof APP_SECTIONS;

function isAppSectionId(id: string): id is AppSectionId {
  return Object.hasOwn(APP_SECTIONS, id);
}

/**
 * The path of an installed app's page, or of one section on it:
 * `appLink("01J…", "secrets")` is `/apps/01J…#secrets`.
 */
export function appLink(installId: string, anchor?: AppSectionId): string {
  const path = `/apps/${encodeURIComponent(installId)}`;
  return anchor === undefined ? path : `${path}#${anchor}`;
}

/**
 * The tab that holds the section a location hash names (`#secrets`, or
 * `secrets` as the router keeps it), or null when it names none.
 */
export function appSectionTab(hash: string): AppTab | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  return isAppSectionId(id) ? APP_SECTIONS[id].tab : null;
}

/**
 * A link to a section of an app's page inside a message string (see
 * `message-links.ts`): "Add it in [the app's domain settings](/apps/…#domains)".
 * Never throws: an install id that does not make a path a message may link
 * to leaves the label as plain text.
 */
export function appPlace(installId: string, anchor: AppSectionId, label: string): string {
  const href = appLink(installId, anchor);
  return isMessageLinkPath(href) ? messageLink(label, href) : label;
}
