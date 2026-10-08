import { type RedirectOptions, redirect } from "@tanstack/react-router";
import { appParam, deployPathFor } from "./app.ts";
import { openedAt } from "./arrival.ts";
import { isDeployPath } from "./paths.ts";

/**
 * The deploy routes run only in a page that was opened at one of them.
 * Reached by an in-app link from another page of the site, the router
 * loads the page afresh instead, so it gets the deploy pages' own response
 * headers (their strict Content-Security-Policy, no referrer) and starts
 * without the analytics the other pages run. The deploy page keeps a valid
 * `?app=` (see `app.ts`), and nothing else of the query.
 */
export function requireDeployDocument(to: "/deploy/" | "/deploy/callback/", search = ""): void {
  if (openedAt === null || isDeployPath(openedAt)) return;
  const app = to === "/deploy/" ? appParam(search) : null;
  const href = app?.kind === "app" ? deployPathFor(app.slug) : null;
  // With `to` set, the router rebuilds the address from `to` and drops the
  // query, so the deploy page with an app is named by `href` alone. The site's
  // route types always ask for `to`, so this one redirect is cast: the router
  // reloads the page at `href` as it is when `to` is absent.
  const byHref = { href, reloadDocument: true } as unknown as RedirectOptions;
  throw href === null ? redirect({ to, reloadDocument: true }) : redirect(byHref);
}
