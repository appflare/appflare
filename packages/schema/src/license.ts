import { z } from "zod";
// With their extensions: the JSON Schema export runs catalog.ts, which
// imports this file, under Node's type stripping.
import { licenseProblem, MAX_LICENSE_NOTE_LENGTH } from "./license-expression.ts";

// The license rules have no Zod in them, so client code (the catalog display
// helpers) can import them without the schemas.
export * from "./license-expression.ts";

/**
 * The catalog manifest's `license` as a manager reads it: any of the forms
 * above, checked for their shape ({@link licenseProblem}). The strict
 * catalog manifest schema adds {@link catalogLicenseProblem}.
 */
export const licenseSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const problem = licenseProblem(value);
    if (problem !== null) ctx.addIssue({ code: "custom", message: `license ${problem}` });
  })
  .describe(
    "The license the app's own repository declares, as an SPDX license expression of current " +
      "SPDX ids: `MIT`, `Apache-2.0`, `GPL-3.0-only`, `MIT OR Apache-2.0`, or a source-available " +
      "license such as `BUSL-1.1`, `FSL-1.1-MIT` or `Elastic-2.0`. Deprecated ids such as " +
      "`GPL-3.0` are refused: write `-only` or `-or-later`, as the project's license notice says. " +
      "For a license without an SPDX id, write `LicenseRef-<name>` and describe it in " +
      "`licenseNote`; write `NONE` when the repository publishes no license. The catalog shows " +
      "the license on the app's card and page; it never decides whether an app is listed.",
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
