import type { CapabilityId } from "../capabilities/capability-rows";
import { messageLink } from "./message-links";

/**
 * Every place in Settings another page, a message or a job error points at:
 * each settings page's path and the sections on it, keyed by the section's
 * element id, with the section's heading. The one map to change when a
 * section moves to another page; every link to a setting is built from it.
 * Client-safe and server-safe (job errors are built from it too).
 */
export const SETTINGS_SECTIONS = {
  account: {
    path: "/settings/account",
    sections: {
      connection: "Cloudflare connection",
      capabilities: "What this account can run",
      "danger-zone": "Danger zone",
    },
  },
  building: {
    path: "/settings/building",
    sections: {
      sandbox: "Build in your account",
      "github-access": "GitHub access",
    },
  },
  updates: {
    path: "/settings/updates",
    sections: {
      apps: "Automatic app updates",
      appflare: "Appflare version",
      versions: "Recent versions",
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
  usageData: {
    path: "/settings/usage-data",
    sections: { "usage-data": "Usage data" },
  },
} as const satisfies Record<string, { path: string; sections: Record<string, string> }>;

export type SettingsPageKey = keyof typeof SETTINGS_SECTIONS;

/** The sections of one settings page, by element id. */
export type SettingsSectionId<P extends SettingsPageKey> =
  keyof (typeof SETTINGS_SECTIONS)[P]["sections"] & string;

/**
 * Anchors below a section: one row per capability on the account page
 * (`capability-r2`), the rows of "What this account can run".
 */
type SettingsRowAnchor<P extends SettingsPageKey> = P extends "account"
  ? `capability-${CapabilityId}`
  : never;

export type SettingsAnchor<P extends SettingsPageKey> = SettingsSectionId<P> | SettingsRowAnchor<P>;

/**
 * The path of a settings page, or of one section (or row) on it:
 * `settingsLink("building", "github-access")` is
 * `/settings/building#github-access`.
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
 * otherwise: "Add a token in [GitHub access settings](…) first."
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
