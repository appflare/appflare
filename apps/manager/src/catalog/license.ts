/**
 * An app's license as the app page shows it: each SPDX license id linked to
 * a plain-language explanation. choosealicense.com explains the common
 * licenses (its pages are named by the lower-case id without `-only` or
 * `-or-later`); any other id of the SPDX License List links to its SPDX
 * page (the schema's copy of the list, `isSpdxLicenseId`). A `LicenseRef-`
 * id, or a word that is not a current SPDX id, stays plain text, as do the
 * operators and parentheses of an expression. Client-safe.
 *
 * Also what kind of license it is, for the catalog's license badge and
 * filter. The catalog lists apps whatever their license and never hides one
 * for it; the badge says plainly what the license allows.
 */

import {
  isSpdxLicenseId,
  LICENSE_NOT_STATED,
  licenseFile,
  licenseIds,
  licenseProblem,
  NO_LICENSE,
  SPDX_DEPRECATED_LICENSE_IDS_TEXT,
} from "@appflare/schema";

/** Licenses choosealicense.com has a page for, by lower-case SPDX id. */
const CHOOSEALICENSE = new Set([
  "0bsd",
  "afl-3.0",
  "agpl-3.0",
  "apache-2.0",
  "artistic-2.0",
  "blueoak-1.0.0",
  "bsd-2-clause-patent",
  "bsd-2-clause",
  "bsd-3-clause-clear",
  "bsd-3-clause",
  "bsd-4-clause",
  "bsl-1.0",
  "cc-by-4.0",
  "cc-by-sa-4.0",
  "cc0-1.0",
  "cecill-2.1",
  "cern-ohl-p-2.0",
  "cern-ohl-s-2.0",
  "cern-ohl-w-2.0",
  "ecl-2.0",
  "epl-1.0",
  "epl-2.0",
  "eupl-1.1",
  "eupl-1.2",
  "gfdl-1.3",
  "gpl-2.0",
  "gpl-3.0",
  "isc",
  "lgpl-2.1",
  "lgpl-3.0",
  "lppl-1.3c",
  "mit-0",
  "mit",
  "mpl-2.0",
  "ms-pl",
  "ms-rl",
  "mulanpsl-2.0",
  "ncsa",
  "odbl-1.0",
  "ofl-1.1",
  "osl-3.0",
  "postgresql",
  "unlicense",
  "upl-1.0",
  "vim",
  "wtfpl",
  "zlib",
]);

/**
 * Ids the SPDX License List still has a page for but no longer recommends
 * (`GPL-3.0`); a custom catalog's entry may carry one.
 */
const DEPRECATED_IDS: ReadonlySet<string> = new Set(SPDX_DEPRECATED_LICENSE_IDS_TEXT.split(" "));

/** Whether `id` is on the SPDX License List, current or deprecated. */
function isListedId(id: string): boolean {
  return isSpdxLicenseId(id) || DEPRECATED_IDS.has(id);
}

/**
 * Where `id` is explained, or null when it is not an id of the SPDX License
 * List (an operator, `NONE`, a `LicenseRef-`, or an id SPDX does not list).
 * A trailing `+` ("or later") links the id itself.
 */
export function licenseHref(id: string): string | null {
  const bare = id.endsWith("+") ? id.slice(0, -1) : id;
  if (!isListedId(bare)) return null;
  const base = bare.toLowerCase().replace(/-(only|or-later)$/, "");
  if (CHOOSEALICENSE.has(base)) return `https://choosealicense.com/licenses/${base}/`;
  return `https://spdx.org/licenses/${encodeURIComponent(bare)}.html`;
}

export interface LicensePart {
  text: string;
  href: string | null;
}

/** The license expression split into linked ids and the plain text between them. */
export function licenseParts(expression: string): LicensePart[] {
  const parts: LicensePart[] = [];
  for (const token of expression.trim().split(/(\s+|[()])/)) {
    if (token === "") continue;
    const href = licenseHref(token);
    const last = parts.at(-1);
    if (href === null && last !== undefined && last.href === null) {
      last.text += token;
    } else {
      parts.push({ text: token, href });
    }
  }
  return parts;
}

/** An app's license as the catalog shows it: the manifest's `license` and `licenseNote`. */
export interface AppLicense {
  expression: string;
  note: string | null;
}

/**
 * What an app's license allows, roughly: an open-source license; a
 * source-available one (the code is public, some uses are not allowed); no
 * license at all; or one the manager cannot place (a license of the app's
 * own, or text that is not an SPDX expression).
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

/** The page of a `SEE LICENSE IN <file>` license's file at the pinned commit, or null. */
export function licenseFileHref(expression: string, repo: string, sha: string): string | null {
  const file = licenseFile(expression);
  if (file === null) return null;
  const path = file.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${sha}/${path}`;
}
