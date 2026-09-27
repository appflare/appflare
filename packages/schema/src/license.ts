import { z } from "zod";

/**
 * An app's license, as its own repository declares it. The catalog lists any
 * app the platform can run and shows the license, whatever it is; it never
 * decides whether an app is listed. The forms a catalog entry should use:
 *
 * - an SPDX license expression (`MIT`, `Apache-2.0`, `MIT OR Apache-2.0`,
 *   `GPL-2.0-or-later WITH Classpath-exception-2.0`, `LicenseRef-Acme`),
 *   source-available licenses such as `BUSL-1.1` included. Ids are checked for
 *   their shape, not against the SPDX list, so a license added to the list
 *   later needs no release here;
 * - `NONE`, for a repository that publishes no license;
 * - `NOASSERTION`, SPDX's "not stated", which builds from a repository without
 *   a catalog entry use when its `package.json` names no license;
 * - `SEE LICENSE IN <file>`, as npm writes it, for a license with no SPDX id.
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
 * The packer's warning for a `license` that is not one of the forms above,
 * or null. A warning, not an error: manifests stored before the check
 * existed (installs, added catalogs, repository builds) carry free text, and
 * must keep parsing.
 */
export function licenseWarning(value: string): string | null {
  const problem = licenseProblem(value);
  return problem === null ? null : `license is not an SPDX expression: it ${problem}`;
}

/**
 * The catalog manifest's `license`: any non-empty text, so every manifest
 * already stored keeps parsing. {@link licenseProblem} says whether it is
 * one of the forms above; the packer warns when it is not, and the manager
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
