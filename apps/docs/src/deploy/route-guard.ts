import { redirect } from "@tanstack/react-router";
import { openedAt } from "./arrival.ts";
import { isDeployPath } from "./paths.ts";

/**
 * The deploy routes run only in a page that was opened at one of them.
 * Reached by an in-app link from another page of the site, the router
 * loads the page afresh instead, so it gets the deploy pages' own response
 * headers (their strict Content-Security-Policy, no referrer) and starts
 * without the analytics the other pages run.
 */
export function requireDeployDocument(to: "/deploy/" | "/deploy/callback/"): void {
  if (openedAt === null || isDeployPath(openedAt)) return;
  throw redirect({ to, reloadDocument: true });
}
