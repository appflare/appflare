/**
 * An app's license as the app page shows it: each SPDX license id linked to
 * a plain-language explanation. choosealicense.com explains the common
 * licenses (its pages are named by the lower-case id without `-only` or
 * `-or-later`); any other id links to its SPDX page. Operators and
 * parentheses of an SPDX expression stay plain text. Client-safe. What kind
 * of license it is, and the badge's words, are shared with the public site in
 * `@appflare/schema/catalog-display`.
 */

import { LICENSE_NOT_STATED, licenseFile, NO_LICENSE } from "@appflare/schema";

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

/** An SPDX license id (or `LicenseRef-…`), as far as its characters go. */
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const OPERATORS = new Set(["AND", "OR", "WITH"]);

/** Values that say there is no license, or none stated: nothing to link. */
const NOT_LICENSES = new Set([NO_LICENSE, LICENSE_NOT_STATED, "UNLICENSED"]);

/** Where `id` is explained, or null when it is not a license id at all. */
export function licenseHref(id: string): string | null {
  if (!SPDX_ID.test(id) || OPERATORS.has(id.toUpperCase())) return null;
  if (NOT_LICENSES.has(id.toUpperCase())) return null;
  const base = id
    .toLowerCase()
    .replace(/\+$/, "")
    .replace(/-(only|or-later)$/, "");
  if (CHOOSEALICENSE.has(base)) return `https://choosealicense.com/licenses/${base}/`;
  if (id.startsWith("LicenseRef-")) return null;
  return `https://spdx.org/licenses/${encodeURIComponent(id)}.html`;
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
