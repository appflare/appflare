/**
 * Links from the manager to appflare.dev carry UTM parameters, so the site's
 * analytics can tell a visit that came from an Appflare (and from which link)
 * from one typed in, and which Appflare version sent it. They say that a
 * manager sent the visitor, never which one: the links keep `noreferrer`
 * and the site drops a manager referrer, since a manager's address is its
 * owner's. Client- and server-safe.
 */

import { BUILD_VERSION } from "./server/build-version";

/** The `utm_source` of every link the manager makes to the site. */
export const MANAGER_UTM_SOURCE = "appflare-manager";

/** Where the link is: on one of the manager's pages, or in a notification it sent. */
export type SiteLinkMedium = "app" | "notification";

/**
 * `url`, an address on appflare.dev, tagged as the manager's link named
 * `link` (a fixed name, such as a docs topic, never anything about the
 * manager or its owner) in Appflare `version`, the campaign. Without a
 * version (code that was not built) there is no campaign. A fragment stays
 * at the end.
 */
export function managerSiteLink(
  url: string,
  link: string,
  medium: SiteLinkMedium = "app",
  version: string | null = BUILD_VERSION,
): string {
  const tagged = new URL(url);
  tagged.searchParams.set("utm_source", MANAGER_UTM_SOURCE);
  tagged.searchParams.set("utm_medium", medium);
  tagged.searchParams.set("utm_content", link);
  if (version !== null) tagged.searchParams.set("utm_campaign", version);
  return tagged.href;
}
