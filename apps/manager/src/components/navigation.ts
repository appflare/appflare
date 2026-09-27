import { SETTINGS_SECTIONS, settingsLink } from "./settings-links";

/**
 * Where things live in the signed-in app: the pages of Settings, in the
 * order the sidebar lists them, and where the addresses Settings used to
 * have lead now. The paths come from the settings link map. Client-safe.
 */

export interface SettingsPage {
  href: string;
  label: string;
  /** One line under the page title. */
  description: string;
}

export const SETTINGS_PAGES = {
  account: {
    href: SETTINGS_SECTIONS.account.path,
    label: "Your account",
    description: "The Cloudflare account Appflare works in, and what it can run.",
  },
  building: {
    href: SETTINGS_SECTIONS.building.path,
    label: "Building apps",
    description:
      "Build apps that have no ready-made release in your own account, including apps from private GitHub repositories.",
  },
  updates: {
    href: SETTINGS_SECTIONS.updates.path,
    label: "Updates",
    description: "How your apps and Appflare itself stay up to date.",
  },
  users: {
    href: SETTINGS_SECTIONS.users.path,
    label: "Users and sign-in",
    description: "Who can sign in to Appflare, and how.",
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
  usageData: {
    href: SETTINGS_SECTIONS.usageData.path,
    label: "Usage data",
    description: "The anonymous daily report Appflare can send.",
  },
} as const satisfies Record<string, SettingsPage>;

export const SETTINGS_PAGE_LIST: SettingsPage[] = Object.values(SETTINGS_PAGES);

/** Where Settings starts: `/settings` itself opens this page. */
export const SETTINGS_HOME = SETTINGS_PAGES.account.href;

/** `pathname` without its trailing slashes (`/` stays `/`). */
function trimPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
}

/** Whether `pathname` is Settings or one of its pages. */
export function isSettingsPath(pathname: string): boolean {
  return isCurrentPage(pathname, "/settings", false);
}

/**
 * The settings pages the menus list: every page, except Removed apps while
 * no uninstalled app keeps anything (it has nothing to show then). While it
 * is the page open, it stays listed, so the menus still show where you are.
 */
export function visibleSettingsPages(removedApps: number, pathname: string): SettingsPage[] {
  const onRemovedApps = isCurrentPage(pathname, SETTINGS_PAGES.removedApps.href, true);
  return SETTINGS_PAGE_LIST.filter(
    (page) => page !== SETTINGS_PAGES.removedApps || removedApps > 0 || onRemovedApps,
  );
}

/** The settings page `pathname` is on, if any. */
export function currentSettingsPage(
  pages: readonly SettingsPage[],
  pathname: string,
): SettingsPage | null {
  return pages.find((page) => isCurrentPage(pathname, page.href, true)) ?? null;
}

/**
 * Sections of the single Settings page that came before these pages, and of
 * the General page that followed it (`/settings#automatic-updates`), by the
 * anchor they had there.
 */
const SETTINGS_ANCHORS: Record<string, string> = {
  "automatic-updates": settingsLink("updates", "apps"),
  "danger-zone": settingsLink("account", "danger-zone"),
  "appflare-updates": settingsLink("updates", "appflare"),
  notifications: settingsLink("notifications"),
  "usage-data": settingsLink("usageData"),
};

/** Sections of the page that listed Appflare's own version and updates. */
const APPFLARE_UPDATES_ANCHORS: Record<string, string> = {
  appflare: settingsLink("updates", "appflare"),
  versions: settingsLink("updates", "versions"),
};

/**
 * Sections that moved off the account page, and the account setup list
 * that became part of "What this account can run".
 */
const ACCOUNT_ANCHORS: Record<string, string> = {
  sandbox: settingsLink("building", "sandbox"),
  "github-access": settingsLink("building", "github-access"),
  checklist: settingsLink("account", "capabilities"),
};

/**
 * Where an address Settings used to have leads now, or null when it is
 * still current. Bookmarks, older notification messages and job errors
 * saved before a page moved carry such addresses:
 *
 * - `/settings` opens Your account, or the page its old anchor moved to;
 * - `/settings/appflare-updates` is the Updates page, at the section it
 *   named (Appflare's version when it named none);
 * - `/settings/account#sandbox` and `#github-access` moved to Building
 *   apps; the account setup list (`#checklist`) is part of "What this
 *   account can run" (`#capabilities`), and its rows are `#capability-<id>`.
 *
 * `hash` is the location hash, with or without its `#`.
 */
export function settingsRedirect(pathname: string, hash: string): string | null {
  const path = trimPath(pathname);
  const anchor = hash.startsWith("#") ? hash.slice(1) : hash;
  if (path === "/settings") return SETTINGS_ANCHORS[anchor] ?? SETTINGS_HOME;
  if (path === "/settings/appflare-updates") {
    return APPFLARE_UPDATES_ANCHORS[anchor] ?? settingsLink("updates", "appflare");
  }
  if (path === SETTINGS_PAGES.account.href) {
    const moved = ACCOUNT_ANCHORS[anchor];
    if (moved !== undefined) return moved;
    const row = /^checklist-([a-z]+(?:-[a-z]+)*)$/.exec(anchor)?.[1];
    if (row !== undefined) return `${SETTINGS_PAGES.account.href}#capability-${row}`;
  }
  return null;
}

/** Whether `pathname` is the page at `href` (with `exact`, and not a page below it). */
export function isCurrentPage(pathname: string, href: string, exact: boolean): boolean {
  const path = trimPath(pathname);
  return exact ? path === href : path === href || path.startsWith(`${href}/`);
}
