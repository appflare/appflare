/**
 * Where things live in the signed-in app: the sidebar's sections and the
 * pages of Settings, in the order the sidebar lists them. Client-safe.
 */

export interface SettingsPage {
  href: string;
  label: string;
  /** One line under the page title. */
  description: string;
}

export const SETTINGS_PAGES = {
  general: {
    href: "/settings",
    label: "General",
    description: "How Appflare looks after the apps it manages.",
  },
  account: {
    href: "/settings/account",
    label: "Account and capabilities",
    description: "The Cloudflare account, its token, and what the account can run.",
  },
  users: {
    href: "/settings/users",
    label: "Users and access",
    description: "Who can sign in to this manager, and how.",
  },
  usageData: {
    href: "/settings/usage-data",
    label: "Usage data",
    description: "The anonymous daily report Appflare can send.",
  },
  notifications: {
    href: "/settings/notifications",
    label: "Notifications",
    description:
      "Send messages about updates, jobs and health to Telegram, Slack, Discord or your own webhook.",
  },
  removedApps: {
    href: "/settings/removed-apps",
    label: "Removed apps",
    description: "Uninstalled apps whose data was kept in the account when they were uninstalled.",
  },
  appflareUpdates: {
    href: "/settings/appflare-updates",
    label: "Appflare updates",
    description: "The version of Appflare running here, and its updates.",
  },
} as const satisfies Record<string, SettingsPage>;

export const SETTINGS_PAGE_LIST: SettingsPage[] = Object.values(SETTINGS_PAGES);

/** The Settings breadcrumb every settings page below General starts with. */
export const SETTINGS_CRUMB = { label: "Settings", href: "/settings" } as const;

/** Whether `pathname` is the page at `href` (Settings' General page only matches exactly). */
export function isCurrentPage(pathname: string, href: string, exact: boolean): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return exact ? path === href : path === href || path.startsWith(`${href}/`);
}
