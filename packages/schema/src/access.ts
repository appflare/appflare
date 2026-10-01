import { z } from "zod";
import { ACCESS_PLACEHOLDERS } from "./placeholders.ts";

/**
 * The catalog manifest's `access` block: how the app goes with Cloudflare
 * Access, which Appflare can put in front of any installed app so only
 * Appflare's users reach it (the manager makes one Access application per
 * install, letting in every Appflare user and Appflare's own health checks).
 *
 * - `mode`: `"required"` (the app has no sign-in of its own, or relies on
 *   Access's: it installs only protected, and its protection cannot be
 *   turned off) or `"recommended"` (the install form's switch starts on).
 *   Without it the switch is offered and starts off.
 * - `bypass`: paths that stay public while the app is protected, such as
 *   share links or a webhook, one Access bypass each on every address the
 *   app answers on.
 *
 * An entry that needs Access to work (`mode: "required"`, or a var filled
 * in with the Access placeholders) must also list `"access"` in `requires`.
 * A manager from before the block strips `access` and leaves the
 * placeholders as written; its index schema does not know the `"access"`
 * requirement, so it leaves such an entry out of its catalog instead of
 * installing it unprotected.
 *
 * This module imports nothing but zod and placeholders: `catalog.ts` imports
 * it, and the JSON Schema export runs `catalog.ts` directly under Node's type
 * stripping.
 */

export const ACCESS_MODES = ["required", "recommended"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

/** How an entry offers protection: its `access.mode`, or `"offered"` without one. */
export type AccessOffer = AccessMode | "offered";

/** At most this many public paths per entry. */
export const MAX_ACCESS_BYPASS_PATHS = 10;

/** The longest public path, in characters. */
export const MAX_ACCESS_BYPASS_PATH_LENGTH = 128;

/** Characters a path segment may hold. */
const SEGMENT_CHARS = "A-Za-z0-9._~@:+=,-";

/**
 * A public path as the JSON Schema states it: one or more `/segment`, then
 * optionally `/*`. The checks below say what is wrong in words.
 */
export const ACCESS_BYPASS_PATH_PATTERN = `^(?:/[${SEGMENT_CHARS}]+)+(?:/\\*)?$`;

const SEGMENT = new RegExp(`^[${SEGMENT_CHARS}]+$`);

/**
 * What is wrong with one public path, or null when nothing is. A path starts
 * with `/`, may end in `/*` (everything under it; Access matches it on that
 * host only, and `/open/*` does not cover `/opener`), and has no other
 * wildcard, no query or fragment, no empty, `.` or `..` segment, and no
 * trailing `/`. `/` and `/*` are refused: they would leave the whole app
 * public.
 */
export function accessBypassPathProblem(path: string): string | null {
  if (path.length > MAX_ACCESS_BYPASS_PATH_LENGTH) {
    return `must be at most ${MAX_ACCESS_BYPASS_PATH_LENGTH} characters`;
  }
  if (!path.startsWith("/")) return 'must start with "/"';
  if (path === "/" || path === "/*") {
    return "would leave the whole app public; list the paths that must stay public instead, or leave the app unprotected";
  }
  if (path.includes("?") || path.includes("#")) {
    return "must be a path only, without a query (?) or fragment (#)";
  }
  const body = path.endsWith("/*") ? path.slice(0, -2) : path;
  if (body.includes("*")) {
    return 'may hold one wildcard only, as a final "/*" (everything under the path)';
  }
  if (body.endsWith("/")) return 'must not end in "/"; write "/path" or "/path/*"';
  for (const segment of body.slice(1).split("/")) {
    if (segment.length === 0) return 'must not contain "//"';
    if (segment === "." || segment === "..") return 'must not contain "." or ".." segments';
    if (!SEGMENT.test(segment)) {
      return "may hold letters, digits and the characters - . _ ~ @ : + = , only";
    }
  }
  return null;
}

/** One public path of `access.bypass`. */
export const accessBypassPathSchema = z
  .string()
  .superRefine((path, ctx) => {
    const problem = accessBypassPathProblem(path);
    if (problem !== null) ctx.addIssue({ code: "custom", message: `${path} ${problem}` });
  })
  .meta({ pattern: ACCESS_BYPASS_PATH_PATTERN, maxLength: MAX_ACCESS_BYPASS_PATH_LENGTH });

export const catalogAccessSchema = z
  .object({
    mode: z
      .enum(ACCESS_MODES)
      .describe(
        '`"required"`: the app is always installed behind Cloudflare Access, and its protection ' +
          "cannot be turned off. For an app with no sign-in of its own, or one that relies on " +
          "Access's. It installs only on accounts with a Zero Trust organization and a Cloudflare " +
          'token with the Access permissions. `"recommended"`: the install form\'s protection ' +
          "switch starts on. Leave it out to offer protection with the switch off.",
      )
      .optional(),
    bypass: z
      .array(accessBypassPathSchema)
      .min(1)
      .max(MAX_ACCESS_BYPASS_PATHS)
      .superRefine((paths, ctx) => {
        const seen = new Set<string>();
        paths.forEach((path, i) => {
          const key = path.toLowerCase();
          if (seen.has(key)) {
            ctx.addIssue({ code: "custom", path: [i], message: `${path} is listed twice` });
          }
          seen.add(key);
        });
      })
      .meta({
        description:
          "Paths that stay public while the app is protected, such as share links " +
          '(`"/s/*"`), `"/.well-known/*"` or a webhook (`"/api/webhook"`). Each starts with `/` ' +
          "and may end in `/*` for everything under it (`/s/*` does not cover `/share`); no " +
          `other wildcard, query or fragment. At most ${MAX_ACCESS_BYPASS_PATHS}. They stay ` +
          "public on every address the app answers on (its workers.dev address and its domains). " +
          "The health check path is not made public: Appflare's health checks sign in with a " +
          "token of their own.",
        uniqueItems: true,
      })
      .optional(),
  })
  .meta({
    description:
      "How the app goes with Cloudflare Access, which Appflare can put in front of any installed " +
      "app so that only the manager's users reach it (and Appflare's own health checks, with a " +
      "service token of the app's own). Without this block protection is offered at install, " +
      "switched off. An app that verifies Access's sign-in itself reads the " +
      "`{{accessTeamDomain}}`, `{{accessAud}}` and `{{accessCertsUrl}}` placeholders from a " +
      "var. Not for the self-deploying tier.",
  });
export type CatalogAccess = z.infer<typeof catalogAccessSchema>;

/** How an entry offers protection with Cloudflare Access. */
export function accessOfferOf(catalog: { access?: CatalogAccess | undefined }): AccessOffer {
  return catalog.access?.mode ?? "offered";
}

/** The paths an entry keeps public while protected; empty when none. */
export function accessBypassPaths(catalog: {
  access?: CatalogAccess | undefined;
}): readonly string[] {
  return catalog.access?.bypass ?? [];
}

/** The `requires` value of an entry that needs Cloudflare Access to work. */
export const ACCESS_REQUIREMENT = "access";

/** The regular expression source of an Access placeholder as written in a value. */
export const ACCESS_PLACEHOLDER_SOURCE = `\\{\\{\\s*(?:${ACCESS_PLACEHOLDERS.join("|")})\\s*\\}\\}`;

/** Whether `text` holds an Access placeholder (`{{accessAud}}` and the other two). */
export function usesAccessPlaceholders(text: string): boolean {
  return new RegExp(ACCESS_PLACEHOLDER_SOURCE).test(text);
}

/** One problem, with its path from the catalog manifest's root. */
export interface AccessRequirementProblem {
  path: Array<string | number>;
  message: string;
}

/**
 * Why an entry must list `"access"` in `requires` and does not: its
 * `access.mode` is `"required"`, or a var's default uses an Access
 * placeholder. Empty when it lists it, or needs not.
 */
export function accessRequirementProblems(manifest: {
  access?: CatalogAccess | undefined;
  requires: readonly string[];
  vars: ReadonlyArray<{ name: string; default?: string | undefined }>;
}): AccessRequirementProblem[] {
  if (manifest.requires.includes(ACCESS_REQUIREMENT)) return [];
  const problems: AccessRequirementProblem[] = [];
  if (manifest.access?.mode === "required") {
    problems.push({
      path: ["requires"],
      message:
        'an entry with "access": { "mode": "required" } must list "access" in requires, so a manager that cannot protect apps never installs it',
    });
  }
  manifest.vars.forEach((v, i) => {
    if (v.default !== undefined && usesAccessPlaceholders(v.default)) {
      problems.push({
        path: ["vars", i, "default"],
        message: `${v.name} uses an Access placeholder, so requires must list "access": a manager that does not fill these in would install the app with the placeholder as written`,
      });
    }
  });
  return problems;
}
