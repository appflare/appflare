import {
  LICENSE_NOT_STATED,
  licenseFile,
  licenseIds,
  licenseProblem,
  NO_LICENSE,
} from "../license-expression";

/**
 * What kind of license an app has, for the catalog's license badge and
 * filter, and the words the badge uses. The catalog lists apps whatever
 * their license and never hides one for it; the badge says plainly what the
 * license allows.
 */

/** An app's license as the catalog shows it: the manifest's `license` and `licenseNote`. */
export interface AppLicense {
  expression: string;
  note: string | null;
}

/**
 * What an app's license allows, roughly: an open-source license; a
 * source-available one (the code is public, some uses are not allowed); no
 * license at all; or one that cannot be placed (a license of the app's own,
 * or text that is not an SPDX expression).
 */
export type LicenseKind = "open-source" | "source-available" | "none" | "unknown";

/** The license filter's choices, with their labels. */
export const LICENSE_FILTERS = {
  "open-source": "Open source",
  "source-available": "Source-available",
  none: "No license",
} as const satisfies Partial<Record<LicenseKind, string>>;
export type LicenseFilter = keyof typeof LICENSE_FILTERS;

/**
 * Source-available license families by SPDX id: the Business Source License,
 * the Functional Source License, the PolyForm licenses, the Elastic License
 * and the Server Side Public License.
 */
const SOURCE_AVAILABLE = /^(?:BUSL|FSL|PolyForm|Elastic|SSPL)-/i;

/**
 * Values that grant no license, in any case: `NONE`, npm's `UNLICENSED`,
 * and `NOASSERTION` (nothing stated, so nothing granted).
 */
const NO_GRANT = new Set([NO_LICENSE, LICENSE_NOT_STATED, "UNLICENSED"]);

/**
 * The kind of `license`. A note makes it source-available, since a note
 * exists to say what the id does not; so does any source-available id in an
 * expression. Every other SPDX expression counts as open source. `LicenseRef-`
 * ids, `SEE LICENSE IN <file>` and text that is not an SPDX expression (a
 * manifest may carry any text) are "unknown".
 */
export function licenseKind(license: AppLicense): LicenseKind {
  const { expression, note } = license;
  if (NO_GRANT.has(expression.trim().toUpperCase())) return "none";
  if (note !== null) return "source-available";
  if (licenseProblem(expression) !== null) return "unknown";
  const ids = licenseIds(expression);
  if (ids.some((id) => SOURCE_AVAILABLE.test(id))) return "source-available";
  if (ids.length === 0 || ids.some((id) => id.includes("LicenseRef-"))) return "unknown";
  return "open-source";
}

export const NO_LICENSE_TOOLTIP =
  "This project publishes no license. You may run it, but you have no license to modify or redistribute it.";

const SOURCE_AVAILABLE_TOOLTIP =
  "The code is public, but the license restricts some uses. Read it before you rely on the app.";

const OPEN_SOURCE_TOOLTIP =
  "An open-source license: you may use, change and share the app on its terms.";

const UNKNOWN_TOOLTIP =
  "A license without a standard identifier. Read it in the app's repository before you rely on the app.";

export interface LicenseBadgeCopy {
  kind: LicenseKind;
  /** Muted words before the label ("Source-available"), or null. */
  prefix: string | null;
  label: string;
  variant: "neutral" | "warning";
  /** What the license allows, in one or two sentences; also the app page's explanation. */
  tooltip: string;
}

/** The words and tone of the license badge on the catalog card and the app page. */
export function licenseBadgeCopy(license: AppLicense): LicenseBadgeCopy {
  const kind = licenseKind(license);
  const file = licenseFile(license.expression);
  // A license of the app's own has no SPDX id to show: `SEE LICENSE IN
  // <file>`, or `LicenseRef-<name>` ids only (the note says what it allows).
  const own =
    file !== null ||
    (licenseProblem(license.expression) === null &&
      licenseIds(license.expression).length > 0 &&
      licenseIds(license.expression).every((id) => id.includes("LicenseRef-")));
  const label = own ? "Custom license" : license.expression;
  const neutral = { kind, prefix: null, label, variant: "neutral" } as const;
  switch (kind) {
    case "none":
      return { ...neutral, label: "No license", variant: "warning", tooltip: NO_LICENSE_TOOLTIP };
    case "source-available":
      return {
        ...neutral,
        prefix: "Source-available",
        tooltip: license.note ?? SOURCE_AVAILABLE_TOOLTIP,
      };
    case "open-source":
      return { ...neutral, tooltip: OPEN_SOURCE_TOOLTIP };
    case "unknown":
      return {
        ...neutral,
        tooltip:
          file !== null
            ? `A license of its own, in ${file} in the app's repository. Read it before you rely on the app.`
            : UNKNOWN_TOOLTIP,
      };
  }
}
