/**
 * The deploy page's paths. Dependency-free, so the Vite config (loaded by
 * Node before the build) can read them.
 */

/** The deploy page. */
export const DEPLOY_PATH = "/deploy/";
/** Where Cloudflare sends the browser back after consent. */
export const CALLBACK_PATH = "/deploy/callback";

/** Whether `pathname` is the deploy page or its callback, where nothing is measured. */
export function isDeployPath(pathname: string): boolean {
  return pathname === "/deploy" || pathname.startsWith("/deploy/");
}

/** Whether `pathname` is the OAuth callback. */
export function isCallbackPath(pathname: string): boolean {
  return pathname === CALLBACK_PATH || pathname === `${CALLBACK_PATH}/`;
}
