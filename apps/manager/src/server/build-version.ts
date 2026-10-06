/**
 * The version this Worker's code was built as. vite.config.ts writes it into
 * the code at build time, from the same `APPFLARE_VERSION` it writes into the
 * Worker's vars. The code cannot be edited on deploy; the var can: the
 * "Deploy to Cloudflare" button's form shows every var as an editable field.
 * So the var is informational, and what the Worker reports as its version
 * comes from here.
 */

// Replaced with a string literal by vite.config.ts's `define`. Undeclared
// where no build ran (the Worker tests), which `typeof` tolerates.
declare const __APPFLARE_BUILD_VERSION__: string | undefined;

/** The built-in version, or null where the code was not built with one. */
export const BUILD_VERSION: string | null =
  typeof __APPFLARE_BUILD_VERSION__ === "string" && __APPFLARE_BUILD_VERSION__.length > 0
    ? __APPFLARE_BUILD_VERSION__
    : null;

/**
 * The version of the code serving this request: the built-in one, else (in
 * the Worker tests, which run the source unbuilt) the `APPFLARE_VERSION` var.
 */
export function runningVersion(env: { APPFLARE_VERSION: string }, build?: string | null): string;
/** Undefined only in an unbuilt Worker whose env has no `APPFLARE_VERSION`. */
export function runningVersion(
  env: { APPFLARE_VERSION?: string },
  build?: string | null,
): string | undefined;
export function runningVersion(
  env: { APPFLARE_VERSION?: string },
  build: string | null = BUILD_VERSION,
): string | undefined {
  return build ?? env.APPFLARE_VERSION;
}
