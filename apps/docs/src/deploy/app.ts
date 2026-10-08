import { CATALOG_SLUG_PATTERN } from "@appflare/schema/links";
import { installTarget } from "../install/request.ts";
import { DEPLOY_PATH } from "./paths.ts";

/**
 * The app a visitor is installing Appflare for. An app's install page on
 * this site sends a visitor without an Appflare to `/deploy/?app=<slug>`;
 * once the new Appflare is set up, it opens that app's install link there,
 * as an Install button would, so they do not have to come back for it.
 *
 * The slug comes from the address bar, so it is checked against the rule
 * every catalog slug follows, and anything else is ignored: the plain
 * journey runs. The page never shows it (the deploy page does not carry
 * the catalog, so it cannot name the app, and a slug is not a name); it
 * only goes into the install link's path, which a checked slug cannot
 * leave.
 */

/** The query parameter `/deploy/` reads the app from. */
export const APP_PARAM = "app";

/** What `?app=` says: no app, an app, or something that is not one (ignored). */
export type AppParam = { kind: "none" } | { kind: "app"; slug: string } | { kind: "invalid" };

/** The app a deploy page's query names, read with the catalog's slug rule. */
export function appParam(search: string): AppParam {
  const values = new URLSearchParams(search).getAll(APP_PARAM);
  if (values.length === 0) return { kind: "none" };
  const [value] = values;
  if (values.length > 1 || value === undefined || !CATALOG_SLUG_PATTERN.test(value)) {
    return { kind: "invalid" };
  }
  return { kind: "app", slug: value };
}

/** The deploy page for an app: `/deploy/?app=<slug>`. Null when `slug` is not one. */
export function deployPathFor(slug: string): string | null {
  return CATALOG_SLUG_PATTERN.test(slug) ? `${DEPLOY_PATH}?${APP_PARAM}=${slug}` : null;
}

/**
 * The app's install link in the Appflare at `address` (`<address>/install/<slug>`),
 * the page an Install button on this site opens. Null when either is not one.
 */
export function appInstallUrl(address: string, slug: string): string | null {
  return installTarget(address, { kind: "app", slug });
}

/**
 * Owner setup that ends at the app's install link: `ownerSetupUrl` (already
 * checked to be `/setup#claim=…` on the new Appflare) with
 * `?returnTo=/install/<slug>`. Appflare sends anyone who opens a page before
 * setup is done to `/setup?returnTo=<that page>`, and takes the claim out of
 * the address while keeping the query, so its Finish opens the app's page,
 * the same as when an install link arrives before setup. Null when the slug
 * or the URL is not one.
 */
export function ownerSetupThenInstall(ownerSetupUrl: string, slug: string): string | null {
  let url: URL;
  try {
    url = new URL(ownerSetupUrl);
  } catch {
    return null;
  }
  const target = appInstallUrl(url.origin, slug);
  if (target === null) return null;
  url.search = new URLSearchParams({ returnTo: new URL(target).pathname }).toString();
  return url.href;
}
