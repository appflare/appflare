import { config } from "zod";
import { isDeployPath } from "./paths.ts";

/**
 * Zod compiles a fast parser for each object schema with `new Function`,
 * after probing once whether the page allows it. The deploy page and its
 * callback forbid evaluating strings (their Content-Security-Policy has no
 * 'unsafe-eval'), so the probe would be blocked and reported as a violation.
 * Turning the compilation off skips the probe; parsing is the same, only
 * without that speed-up.
 *
 * Only on those two pages: every other page keeps Zod's default. The switch
 * has to happen before any schema exists, and some schemas are built by
 * code every page loads, before a route's own code arrives, so it is made
 * here, from `arrival.ts` (the first module the site runs), for the page
 * the document was opened at. The deploy routes always open as a document
 * of their own (`route-guard.ts`), so that address is theirs.
 */
if (typeof location !== "undefined" && isDeployPath(location.pathname)) {
  config({ jitless: true });
}
