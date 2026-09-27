import { SETTINGS_SECTIONS } from "./settings-links";

/**
 * Where things live in the signed-in app: the sidebar's sections and the
 * pages of Settings, in the order the sidebar lists them. The paths come
 * from the settings link map. Client-safe.
 */

export interface SettingsPage {
  href: string;
  label: string;
  /** One line under the page title. */
  description: string;
}

export const SETTINGS_PAGES = {
  general: {
    href: SETTINGS_SECTIONS.general.path,
    label: "General",
    description: "How Appflare looks after the apps it manages.",
  },
  account: {
    href: SETTINGS_SECTIONS.account.path,
    label: "Account and capabilities",
    description: "The Cloudflare account, its token, and what the account can run.",
  },
  users: {
    href: SETTINGS_SECTIONS.users.path,
    label: "Users and access",
    description: "Who can sign in to this manager, and how.",
  },
  usageData: {
    href: SETTINGS_SECTIONS.usageData.path,
    label: "Usage data",
    description: "The anonymous daily report Appflare can send.",
  },
  domains: {
    href: SETTINGS_SECTIONS.domains.path,
    label: "Domains",
    description:
      "Serve apps on hostnames in other people's DNS, through Cloudflare for SaaS on one of your domains.",
  },
  notifications: {
    href: SETTINGS_SECTIONS.notifications.path,
    label: "Notifications",
    description:
      "Send messages about updates, jobs and health to Telegram, Slack, Discord or your own webhook.",
  },
  catalogs: {
    href: SETTINGS_SECTIONS.catalogs.path,
    label: "Catalogs",
    description:
      "Where apps come from: the official catalog, and catalogs you add with their signing keys.",
  },
  removedApps: {
    href: SETTINGS_SECTIONS.removedApps.path,
    label: "Removed apps",
    description: "Uninstalled apps whose data was kept in the account when they were uninstalled.",
  },
  appflareUpdates: {
    href: SETTINGS_SECTIONS.appflareUpdates.path,
    label: "Appflare updates",
    description: "The version of Appflare running here, and its updates.",
  },
} as const satisfies Record<string, SettingsPage>;

export const SETTINGS_PAGE_LIST: SettingsPage[] = Object.values(SETTINGS_PAGES);

/**
 * Where a section anchor of the single Settings page that came before these
 * pages now lives (`#appflare-updates` is the Appflare updates page); null
 * for any other hash, including the sections still on General
 * (`#automatic-updates`, `#danger-zone`), which the page scrolls to itself.
 */
export function settingsPageForAnchor(hash: string): string | null {
  const anchors: Record<string, string> = {
    "#appflare-updates": SETTINGS_PAGES.appflareUpdates.href,
    "#notifications": SETTINGS_PAGES.notifications.href,
    "#usage-data": SETTINGS_PAGES.usageData.href,
  };
  return anchors[hash] ?? null;
}

/** Whether `pathname` is the page at `href` (Settings' General page only matches exactly). */
export function isCurrentPage(pathname: string, href: string, exact: boolean): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return exact ? path === href : path === href || path.startsWith(`${href}/`);
}
