import { z } from "zod";
import {
  SPDX_DEPRECATED_LICENSE_IDS_TEXT,
  SPDX_EXCEPTION_IDS_TEXT,
  SPDX_LICENSE_IDS_TEXT,
  SPDX_LICENSE_LIST_VERSION,
} from "./spdx-ids.ts";

/**
 * An app's license, as its own repository declares it. The catalog lists any
 * app the platform can run and shows the license, whatever it is; it never
 * decides whether an app is listed. The forms a manifest may hold:
 *
 * - an SPDX license expression (`MIT`, `Apache-2.0`, `MIT OR Apache-2.0`,
 *   `GPL-2.0-or-later WITH Classpath-exception-2.0`, `LicenseRef-Acme`),
 *   source-available licenses such as `BUSL-1.1` included;
 * - `NONE`, for a repository that publishes no license;
 * - `NOASSERTION`, SPDX's "not stated", and `SEE LICENSE IN <file>`, as npm
 *   writes it: only in the manifest Appflare writes for an app built from a
 *   repository without a catalog entry, from its `package.json`.
 *
 * Reading a manifest checks only the shape ({@link licenseProblem}), so a
 * manager reads a license SPDX adds later. Writing a catalog entry checks
 * the ids against the SPDX list and refuses the repository-build forms
 * ({@link catalogLicenseProblem}, in the strict catalog manifest schema).
 */

/** The manifest value for a repository that publishes no license. */
export const NO_LICENSE = "NONE";

/** SPDX's value for a license nobody stated. */
export const LICENSE_NOT_STATED = "NOASSERTION";

/** The largest `licenseNote`. */
export const MAX_LICENSE_NOTE_LENGTH = 160;

const SEE_LICENSE_IN = /^SEE LICENSE IN (\S(?:[^\r\n]*\S)?)$/;

/** An SPDX license id, `+` allowed at the end, or a `LicenseRef-`, optionally in another document. */
const LICENSE_ID =
  /^(?:DocumentRef-[A-Za-z0-9.-]+:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.-]*\+?)$/;
/** An SPDX exception id, after `WITH`. */
const EXCEPTION_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
/** SPDX operators are all upper case or all lower case. */
const OPERATORS = new Set(["AND", "OR", "WITH", "and", "or", "with"]);
/** Values that stand alone and only in capitals. */
const STANDALONE = new Set([NO_LICENSE, LICENSE_NOT_STATED]);

/** The file of a `SEE LICENSE IN <file>` value, or null for any other value. */
export function licenseFile(value: string): string | null {
  return SEE_LICENSE_IN.exec(value)?.[1] ?? null;
}

/**
 * Checks an SPDX license expression: ids joined by `AND` and `OR`, each
 * optionally followed by `WITH` and an exception id, grouped with
 * parentheses. Returns what is wrong, or null.
 */
function expressionProblem(value: string): string | null {
  const tokens = value.split(/(\s+|[()])/).filter((t) => t.trim() !== "");
  let at = 0;
  const peek = () => tokens[at];

  // term := "(" expression ")" | id [WITH exception]
  const term = (): string | null => {
    const token = peek();
    if (token === undefined) return "ends where a license id belongs";
    if (token === "(") {
      at += 1;
      const inner = expression();
      if (inner !== null) return inner;
      if (peek() !== ")") return "has a parenthesis that is never closed";
      at += 1;
      return null;
    }
    if (STANDALONE.has(token.toUpperCase())) {
      return `uses ${token.toUpperCase()}, which stands alone in capitals, not inside an expression`;
    }
    if (OPERATORS.has(token) || token === ")") return `has "${token}" where a license id belongs`;
    if (!LICENSE_ID.test(token)) return `has "${token}", which is not an SPDX license id`;
    at += 1;
    if (peek() === "WITH" || peek() === "with") {
      at += 1;
      const exception = peek();
      if (exception === undefined || !EXCEPTION_ID.test(exception)) {
        return "needs an exception id after WITH";
      }
      at += 1;
    }
    return null;
  };

  // expression := term ((AND | OR) term)*
  const expression = (): string | null => {
    const first = term();
    if (first !== null) return first;
    for (;;) {
      const op = peek();
      if (op !== "AND" && op !== "OR" && op !== "and" && op !== "or") return null;
      at += 1;
      const next = term();
      if (next !== null) return next;
    }
  };

  const problem = expression();
  if (problem !== null) return problem;
  const rest = peek();
  if (rest === ")") return "closes a parenthesis that was never opened";
  if (rest !== undefined) return `has "${rest}" where AND, OR or WITH belongs`;
  return null;
}

/** What is wrong with a `license` value, or null when it is one the manifest takes. */
export function licenseProblem(value: string): string | null {
  if (value.trim() === "") return "must not be empty";
  if (value !== value.trim()) return "must not start or end with a space";
  if (STANDALONE.has(value)) return null;
  if (value.startsWith("SEE LICENSE IN")) {
    const file = licenseFile(value);
    if (file === null) return 'must name the file: "SEE LICENSE IN <file>"';
    if (file.startsWith("/") || file.split("/").includes("..")) {
      return "must name a file inside the repository";
    }
    return null;
  }
  if (STANDALONE.has(value.toUpperCase())) {
    return `must be written "${value.toUpperCase()}", in capitals`;
  }
  return expressionProblem(value);
}

/** Whether `value` is a `license` value the manifest takes. */
export function isLicense(value: string): boolean {
  return licenseProblem(value) === null;
}

/**
 * The SPDX license ids of an expression, exceptions left out; empty for
 * `NONE`, `NOASSERTION` and `SEE LICENSE IN <file>`. Assumes a valid value.
 */
export function licenseIds(value: string): string[] {
  if (STANDALONE.has(value) || licenseFile(value) !== null) return [];
  const ids: string[] = [];
  let afterWith = false;
  for (const token of value.split(/[\s()]+/)) {
    if (token === "") continue;
    if (OPERATORS.has(token)) {
      afterWith = token.toUpperCase() === "WITH";
      continue;
    }
    if (!afterWith) ids.push(token);
    afterWith = false;
  }
  return ids;
}

/**
 * How a catalog entry must write its license, beyond the shape
 * {@link licenseProblem} checks; null when it may. Enforced where manifests
 * are written (the strict catalog manifest schema that the packer, the
 * catalog checks and the CLI use), not where they are read:
 *
 * - every license id is a current id of the SPDX License List (the version
 *   in {@link SPDX_LICENSE_LIST_VERSION}), in its exact case, or a
 *   `LicenseRef-<name>`; a deprecated id is refused with its replacement
 *   (`GPL-3.0` must say `GPL-3.0-only` or `GPL-3.0-or-later`, as the
 *   project's license notice does: "or any later version" means
 *   `-or-later`);
 * - every exception after `WITH` is a current SPDX exception id or an
 *   `AdditionRef-<name>`;
 * - `NONE` is allowed; `NOASSERTION` and `SEE LICENSE IN <file>` only with
 *   `repositoryBuild`, for the manifest Appflare writes for an app built
 *   from a repository without a catalog entry.
 */
export function catalogLicenseProblem(
  value: string,
  options: { repositoryBuild?: boolean } = {},
): string | null {
  const shape = licenseProblem(value);
  if (shape !== null) return shape;
  if (value === LICENSE_NOT_STATED || licenseFile(value) !== null) {
    return options.repositoryBuild === true
      ? null
      : `is "${value}", which only an app built from a repository without a catalog entry may have; a catalog entry names its license with an SPDX id, a LicenseRef-<name>, or NONE`;
  }
  if (value === NO_LICENSE) return null;
  for (const token of value.split(/[\s()]+/)) {
    if (token === "" || OPERATORS.has(token)) continue;
    const problem = idProblem(token);
    if (problem !== null) return problem;
  }
  return null;
}

const CURRENT_IDS: ReadonlySet<string> = new Set(SPDX_LICENSE_IDS_TEXT.split(" "));
const DEPRECATED_IDS: ReadonlySet<string> = new Set(SPDX_DEPRECATED_LICENSE_IDS_TEXT.split(" "));
const EXCEPTION_IDS: ReadonlySet<string> = new Set(SPDX_EXCEPTION_IDS_TEXT.split(" "));
const BY_LOWER_CASE: ReadonlyMap<string, string> = new Map(
  [...CURRENT_IDS, ...EXCEPTION_IDS].map((id) => [id.toLowerCase(), id]),
);

/** Whether `id` is a current SPDX license id, in its exact case. */
export function isSpdxLicenseId(id: string): boolean {
  return CURRENT_IDS.has(id);
}

/** Why one id of an expression (a license or an exception) is not one a catalog entry may use. */
function idProblem(token: string): string | null {
  if (/^(?:DocumentRef-[A-Za-z0-9.-]+:)?(?:LicenseRef|AdditionRef)-[A-Za-z0-9.-]+$/.test(token)) {
    return null;
  }
  if (CURRENT_IDS.has(token) || EXCEPTION_IDS.has(token)) return null;
  const bare = token.endsWith("+") ? token.slice(0, -1) : token;
  if (CURRENT_IDS.has(`${bare}-or-later`)) {
    return token.endsWith("+")
      ? `has "${token}", a deprecated SPDX form; write ${bare}-or-later`
      : `has "${token}", a deprecated SPDX id; write ${bare}-only or ${bare}-or-later, as the project's license notice says ("or any later version" means -or-later)`;
  }
  if (token.endsWith("+") && CURRENT_IDS.has(bare)) return null;
  if (DEPRECATED_IDS.has(token)) {
    return `has "${token}", a deprecated SPDX id; use its current id from https://spdx.org/licenses/`;
  }
  const cased = BY_LOWER_CASE.get(token.toLowerCase());
  if (cased !== undefined) return `has "${token}", which SPDX writes "${cased}"`;
  return `has "${token}", which is not an id of the SPDX License List ${SPDX_LICENSE_LIST_VERSION}; for a license without one, write LicenseRef-<name> and describe it in licenseNote`;
}

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
