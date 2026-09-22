/** The oldest Node.js major version the CLI (and the wrangler it drives) supports. */
export const MIN_NODE_MAJOR = 22;

/**
 * Throws a readable error unless `version` (default: the running Node.js) is at
 * least {@link MIN_NODE_MAJOR}. `bin/appflare.js` repeats this check in plain
 * JavaScript before anything else loads, so older Node versions get the same
 * message instead of a syntax error.
 */
export function checkNodeVersion(version: string = process.versions.node): void {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new Error(
      `Appflare's installer needs Node.js ${MIN_NODE_MAJOR} or newer; this is Node.js ${version}. ` +
        "Install a current Node.js from https://nodejs.org and run it again.",
    );
  }
}
