import { z } from "zod";

/** The longest `openPath`, in characters. */
export const MAX_OPEN_PATH_LENGTH = 128;

/** Characters a segment of `openPath` may hold. */
const SEGMENT_CHARS = "A-Za-z0-9._~@:+=,-";

const SEGMENT = new RegExp(`^[${SEGMENT_CHARS}]+$`);

/**
 * `openPath` as the JSON Schema states it: one or more `/segment`, then
 * optionally a final `/`. {@link openPathProblem} says what is wrong in words.
 */
export const OPEN_PATH_PATTERN = `^(?:/[${SEGMENT_CHARS}]+)+/?$`;

/**
 * What is wrong with an entry's `openPath`, or null when nothing is. It is a
 * path on the app's own address: it starts with `/`, has no scheme, host,
 * query or fragment, no empty, `.` or `..` segment, and may end in `/`. `/`
 * alone is refused: it is where the app opens without one.
 */
export function openPathProblem(path: string): string | null {
  if (path.length > MAX_OPEN_PATH_LENGTH) {
    return `must be at most ${MAX_OPEN_PATH_LENGTH} characters`;
  }
  if (!path.startsWith("/")) return 'must be a path on the app\'s address, starting with "/"';
  if (path === "/") return "is where the app opens anyway; leave openPath out instead";
  if (path.includes("?") || path.includes("#")) {
    return "must be a path only, without a query (?) or fragment (#)";
  }
  const body = path.endsWith("/") ? path.slice(1, -1) : path.slice(1);
  for (const segment of body.split("/")) {
    if (segment.length === 0) return 'must not contain "//"';
    if (segment === "." || segment === "..") return 'must not contain "." or ".." segments';
    if (!SEGMENT.test(segment)) {
      return "may hold letters, digits, / and the characters - . _ ~ @ : + = , only";
    }
  }
  return null;
}

/**
 * A catalog manifest's `openPath`: where in the app the manager's Open
 * buttons take people, for an app whose interface is not at its root (an
 * admin dashboard at `/dashboard`). Health checks, `{{appUrl}}` and the
 * addresses the manager lists stay the root.
 */
export const openPathSchema = z
  .string()
  .superRefine((path, ctx) => {
    const problem = openPathProblem(path);
    if (problem !== null) ctx.addIssue({ code: "custom", message: `openPath ${problem}` });
  })
  .meta({ pattern: OPEN_PATH_PATTERN, maxLength: MAX_OPEN_PATH_LENGTH })
  .describe(
    "Where the manager's Open buttons take people in the app, as a path on its address, for " +
      "an app whose interface is not at its root, for example `/dashboard`. It starts with " +
      "`/`, has no query or fragment, no empty, `.` or `..` segments, and holds letters, " +
      `digits and \`- . _ ~ @ : + = ,\` only, at most ${MAX_OPEN_PATH_LENGTH} characters; it may end in \`/\`. Omitted means the ` +
      "root. Health checks, `{{appUrl}}` and the addresses the manager lists stay the root, so " +
      "a `postInstall` note links to the path itself (`{{appUrl}}/dashboard`). A manager from " +
      "before this field opens the root.",
  );

/**
 * The URL an Open button goes to: the app's `address` (an origin such as
 * `https://links.example.com`, without a trailing slash) with `openPath`
 * after it. Null without an address; the address itself without a path, or
 * with one that {@link openPathProblem} refuses.
 */
export function appOpenUrl(
  address: string | null,
  openPath: string | null | undefined,
): string | null {
  if (address === null) return null;
  if (openPath === null || openPath === undefined || openPathProblem(openPath) !== null) {
    return address;
  }
  return `${address.replace(/\/+$/, "")}${openPath}`;
}
