import type { ChecklistRowId } from "../onboarding/checklist";
import { messageLink } from "./message-links";

/**
 * Every place in Settings another page, a message or a job error points at:
 * each settings page's path and the sections on it, keyed by the section's
 * element id, with the section's heading. The one map to change when a
 * section moves to another page; every link to a setting is built from it.
 * Client-safe and server-safe (job errors are built from it too).
 */
export const SETTINGS_SECTIONS = {
  general: {
    path: "/settings",
    sections: {
      "automatic-updates": "Automatic updates",
      "danger-zone": "Danger zone",
    },
  },
  account: {
    path: "/settings/account",
    sections: {
      connection: "Cloudflare connection",
      checklist: "Onboarding checklist",
      capabilities: "Account capabilities",
      sandbox: "Sandbox builds",
      "github-access": "GitHub access",
    },
  },
  users: {
    path: "/settings/users",
    sections: {
      users: "Users",
      "forgotten-passwords": "Forgotten passwords",
      passkeys: "Your passkeys",
      access: "Cloudflare Access",
    },
  },
  usageData: {
    path: "/settings/usage-data",
    sections: { "usage-data": "Usage data" },
  },
  domains: {
    path: "/settings/domains",
    sections: { "external-domains": "External domains" },
  },
  notifications: {
    path: "/settings/notifications",
    sections: { channels: "Channels" },
  },
  catalogs: {
    path: "/settings/catalogs",
    sections: { catalogs: "Catalogs" },
  },
  removedApps: {
    path: "/settings/removed-apps",
    sections: { "removed-apps": "Removed apps" },
  },
  appflareUpdates: {
    path: "/settings/appflare-updates",
    sections: {
      appflare: "Appflare",
      versions: "Versions",
    },
  },
} as const satisfies Record<string, { path: string; sections: Record<string, string> }>;

export type SettingsPageKey = keyof typeof SETTINGS_SECTIONS;

/** The sections of one settings page, by element id. */
export type SettingsSectionId<P extends SettingsPageKey> =
  keyof (typeof SETTINGS_SECTIONS)[P]["sections"] & string;

/**
 * Anchors below a section: the onboarding checklist's rows on the account
 * page (`checklist-r2`), which the checklist itself gives those ids.
 */
type SettingsRowAnchor<P extends SettingsPageKey> = P extends "account"
  ? `checklist-${ChecklistRowId}`
  : never;

export type SettingsAnchor<P extends SettingsPageKey> = SettingsSectionId<P> | SettingsRowAnchor<P>;

/**
 * The path of a settings page, or of one section (or row) on it:
 * `settingsLink("account", "github-access")` is
 * `/settings/account#github-access`.
 */
export function settingsLink<P extends SettingsPageKey>(
  page: P,
  anchor?: SettingsAnchor<P>,
): string {
  const { path } = SETTINGS_SECTIONS[page];
  return anchor === undefined ? path : `${path}#${anchor}`;
}

/** The heading of a section, the same words its link and its page show. */
export function settingsSectionTitle<P extends SettingsPageKey>(
  page: P,
  section: SettingsSectionId<P>,
): string {
  const sections: Record<string, string> = SETTINGS_SECTIONS[page].sections;
  const title = sections[section];
  if (title === undefined) throw new Error(`no section "${section}" on the ${page} settings page`);
  return title;
}

/**
 * A settings section's element id and heading, for `Section`:
 * `<Section {...settingsSection("users", "passkeys")}>`.
 */
export function settingsSection<P extends SettingsPageKey>(
  page: P,
  section: SettingsSectionId<P>,
): { id: string; title: string } {
  return { id: section, title: settingsSectionTitle(page, section) };
}

/**
 * A link to a settings section inside a message string (see
 * `message-links.ts`), labelled "<heading> settings" unless `label` says
 * otherwise: "Enable sandbox builds in [Sandbox builds settings](…) first."
 */
export function settingsPlace<P extends SettingsPageKey>(
  page: P,
  section: SettingsSectionId<P>,
  label?: string,
): string {
  return messageLink(
    label ?? `${settingsSectionTitle(page, section)} settings`,
    settingsLink(page, section),
  );
}
