import { z } from "zod";

/**
 * Two lists an entry's page shows to people deciding whether to install it:
 * `features`, what the app does for them, and `alternativeTo`, the
 * well-known products it can replace. Both are copy only: the catalog shows
 * them from the current manifest, so an edit needs no release and no revision.
 */

/** The fewest `features` an entry lists when it lists any. */
export const MIN_APP_FEATURES = 3;
/** The most `features` an entry lists. */
export const MAX_APP_FEATURES = 6;
/** The longest feature line, in characters. */
export const MAX_APP_FEATURE_LENGTH = 100;
/** The most `alternativeTo` names an entry lists. */
export const MAX_APP_ALTERNATIVES = 5;
/** The longest `alternativeTo` name, in characters. */
export const MAX_APP_ALTERNATIVE_LENGTH = 40;

const ONE_LINE = /^\S(?:[^\r\n]*\S)?$/;
const ONE_LINE_MESSAGE = "must be one line without leading or trailing spaces";

/**
 * Refuses a list that names one item twice, ignoring case, with the second
 * one's position.
 */
function eachOnce(list: readonly string[], ctx: z.core.$RefinementCtx<string[]>): void {
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const key = item.toLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({ code: "custom", path: [i], message: `"${item}" is listed twice` });
    }
    seen.add(key);
  });
}

/** One line of `features`: what the app does for the person, as a caption. */
export const appFeatureSchema = z
  .string()
  .min(1, "must not be empty")
  .max(MAX_APP_FEATURE_LENGTH, `must be at most ${MAX_APP_FEATURE_LENGTH} characters`)
  .regex(ONE_LINE, ONE_LINE_MESSAGE)
  .regex(/[^.]$/, "must not end with a period");

/** The catalog manifest's `features`. */
export const appFeaturesSchema = z
  .array(appFeatureSchema)
  .min(
    MIN_APP_FEATURES,
    `must list at least ${MIN_APP_FEATURES} features; leave it out to list none`,
  )
  .max(MAX_APP_FEATURES, `must list at most ${MAX_APP_FEATURES} features`)
  .superRefine(eachOnce)
  .meta({
    uniqueItems: true,
    description:
      `What the app does for the person who installs it, as ${MIN_APP_FEATURES} to ` +
      `${MAX_APP_FEATURES} plain lines of at most ${MAX_APP_FEATURE_LENGTH} characters each, ` +
      'without a trailing period, such as "Share short links that open your long ones". ' +
      "Written for people who are not developers, from the upstream project's own description, " +
      "each line saying something different. Shown on the app's page. Leave it out to list none.",
  });

/**
 * No address in an `alternativeTo` name: no slash (so no scheme or path) and
 * no leading `www.`. Product names such as "Monday.com" stay allowed.
 */
const NOT_A_URL = /^(?![Ww]{3}\.)[^/]*$/;

/** One name of `alternativeTo`: a well-known product or service, not its address. */
export const appAlternativeSchema = z
  .string()
  .min(1, "must not be empty")
  .max(MAX_APP_ALTERNATIVE_LENGTH, `must be at most ${MAX_APP_ALTERNATIVE_LENGTH} characters`)
  .regex(ONE_LINE, ONE_LINE_MESSAGE)
  .regex(NOT_A_URL, "must be a product's name, not a URL");

/** The catalog manifest's `alternativeTo`. */
export const appAlternativesSchema = z
  .array(appAlternativeSchema)
  .min(1, "must list at least 1 product; leave it out to list none")
  .max(MAX_APP_ALTERNATIVES, `must list at most ${MAX_APP_ALTERNATIVES} products`)
  .superRefine(eachOnce)
  .meta({
    uniqueItems: true,
    description:
      `The well-known products or services the app can replace, as 1 to ${MAX_APP_ALTERNATIVES} ` +
      `names of at most ${MAX_APP_ALTERNATIVE_LENGTH} characters each, such as ` +
      '"Google Analytics" or "Plausible". Names only, no URLs. Shown on the app\'s page. ' +
      "Leave it out to list none.",
  });
