/**
 * An app's license as the app page shows it: each SPDX license id linked to
 * a plain-language explanation. choosealicense.com explains the common
 * licenses (its pages are named by the lower-case id without `-only` or
 * `-or-later`); any other id of the SPDX License List links to its SPDX
 * page (the schema's copy of the list, `isSpdxLicenseId`). A `LicenseRef-`
 * id, or a word that is not a current SPDX id, stays plain text, as do the
 * operators and parentheses of an expression. Client-safe. What kind of
 * license it is, and the badge's words, are shared with the public site in
 * `@appflare/schema/catalog-display`.
 */

import { isSpdxLicenseId, licenseFile, SPDX_DEPRECATED_LICENSE_IDS_TEXT } from "@appflare/schema";

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

/** The page of a `SEE LICENSE IN <file>` license's file at the pinned commit, or null. */
export function licenseFileHref(expression: string, repo: string, sha: string): string | null {
  const file = licenseFile(expression);
  if (file === null) return null;
  const path = file.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${sha}/${path}`;
}
