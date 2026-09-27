import { z } from "zod";

/** The longest tagline, in characters: it has to fit two short lines on a catalog tile. */
export const MAX_TAGLINE_LENGTH = 80;

/**
 * A catalog entry's `tagline`: what the app does, as one plain sentence
 * short enough for a catalog tile ("Short links on your own domain"). It
 * reads as a caption, so it has no trailing period. When an entry has none,
 * the manager shortens `summary` instead.
 */
export const taglineSchema = z
  .string()
  .min(1)
  .max(MAX_TAGLINE_LENGTH)
  .regex(/^\S(?:[^\r\n]*\S)?$/, "must be one line without leading or trailing spaces")
  .regex(/[^.]$/, "must not end with a period")
  .describe(
    `What the app does, as one plain sentence of at most ${MAX_TAGLINE_LENGTH} characters, ` +
      'without a trailing period, such as "Short links on your own domain". Shown under the ' +
      "app's name on catalog tiles; when omitted, the catalog shortens `summary` instead.",
  );
