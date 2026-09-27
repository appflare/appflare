import { type AppSignal, homeName } from "../home/attention";

/**
 * The sidebar's "Your apps" list: every install by name, each with the dot
 * of its most severe "Needs attention" row, narrowed by the group's filter.
 * Client-safe.
 */

/** At most this many rows show; the rest scroll inside the group. */
export const MAX_VISIBLE_APPS = 8;

export interface SidebarApp {
  id: string;
  /**
   * What the row says: the name Home uses (`homeName`), or the install's
   * label (`installLabel`) when another install goes by the same name.
   */
  label: string;
  /** The app's name from the catalog, which the filter also matches. */
  name: string;
  icon: string | null;
  signal: AppSignal | null;
}

/** The installs, sorted by what the sidebar calls them. */
export function sidebarApps(
  apps: readonly {
    id: string;
    label: string;
    displayName: string | null;
    name: string;
    icon: string | null;
  }[],
  signals: ReadonlyMap<string, AppSignal>,
): SidebarApp[] {
  const uses = new Map<string, number>();
  for (const app of apps) uses.set(homeName(app), (uses.get(homeName(app)) ?? 0) + 1);
  return apps
    .map((app) => ({
      id: app.id,
      // Two installs of one app without names of their own: the labels tell them apart.
      label: (uses.get(homeName(app)) ?? 0) > 1 ? app.label : homeName(app),
      name: app.name,
      icon: app.icon,
      signal: signals.get(app.id) ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

/** The apps whose label or app name contains the query, ignoring case; all of them for an empty query. */
export function filterApps(apps: readonly SidebarApp[], query: string): SidebarApp[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return [...apps];
  return apps.filter(
    (app) => app.label.toLocaleLowerCase().includes(q) || app.name.toLocaleLowerCase().includes(q),
  );
}

/** The install whose page is open (`/apps/<id>` and below), if any. */
export function currentAppId(pathname: string): string | null {
  const match = /^\/apps\/([^/]+)/.exec(pathname);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

/** The Kumo sidebar item id of an app's row, for `scrollItemIntoView`. */
export function appItemId(id: string): string {
  return `app-${id}`;
}
