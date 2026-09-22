/** The manager's default Worker name. */
export const DEFAULT_WORKER_NAME = "appflare";

/**
 * Worker names the CLI accepts: lowercase letters, digits, and inner dashes, at
 * most 58 characters. That keeps `<name>.<subdomain>.workers.dev` a valid DNS
 * label and leaves room for the suffixes derived from it (`<name>-kv`,
 * `<name>-jobs`) within Cloudflare's 63/64-character limits.
 */
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;

/** Throws unless `name` is an acceptable Worker name; returns it otherwise. */
export function validateWorkerName(name: string): string {
  if (!WORKER_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a valid Worker name: use lowercase letters, digits, and dashes ` +
        "(not at the start or end), at most 58 characters.",
    );
  }
  return name;
}

/**
 * The name wrangler gives a resource it auto-provisions for a binding that has
 * no name of its own (KV namespaces): `<worker>-<binding, lowercased, _ -> ->`.
 * Mirrors `autoProvisionedResourceName` in wrangler 4.136
 * (workers-sdk packages/deploy-helpers, provisioning).
 */
export function autoProvisionedResourceName(workerName: string, bindingName: string): string {
  return `${workerName}-${bindingName.toLowerCase().replaceAll("_", "-")}`;
}
