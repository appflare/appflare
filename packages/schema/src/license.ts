import { z } from "zod";
// With their extensions: the JSON Schema export runs catalog.ts, which
// imports this file, under Node's type stripping.
import { MAX_LICENSE_NOTE_LENGTH } from "./license-expression.ts";

// The expression rules have no Zod in them, so client code (the catalog
// display helpers) can import them without the schemas.
export * from "./license-expression.ts";

/**
 * The catalog manifest's `license`: any non-empty text, so every manifest
 * already stored keeps parsing. `licenseProblem` says whether it is one of
 * the forms license-expression.ts lists; the packer warns when it is not, and the manager
 * shows a value it cannot place as it is.
 */
export const licenseSchema = z
  .string()
  .min(1)
  .describe(
    "The license the app's own repository declares, as an SPDX license expression: `MIT`, " +
      "`Apache-2.0`, `MIT OR Apache-2.0`, or a source-available license such as `BUSL-1.1`, " +
      "`FSL-1.1-MIT` or `Elastic-2.0`. Use `NONE` when the repository publishes no license, " +
      "and `SEE LICENSE IN <file>` (a path in the repository) for a license with no SPDX id. " +
      "The catalog shows the license on the app's card and page; it never decides whether an " +
      "app is listed.",
  );

/** The catalog manifest's `licenseNote`: one short line shown next to the license. */
export const licenseNoteSchema = z
  .string()
  .min(1)
  .max(MAX_LICENSE_NOTE_LENGTH)
  .regex(/^\S(?:[^\r\n]*\S)?$/, "must be one line without leading or trailing spaces")
  .describe(
    "One short line shown next to the license, for what its id does not say, such as " +
      '"Source-available: production use restricted; see the license". An app with a ' +
      "note is shown as source-available.",
  );
