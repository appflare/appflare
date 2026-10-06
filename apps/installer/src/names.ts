import { z } from "zod";

/**
 * The names an installation uses. They follow `create-appflare`'s, so a
 * manager deployed from the browser looks the same in the dashboard as one
 * deployed from the command line: the Worker `<name>`, the D1 database
 * `<name>`, the KV namespace `<name>-kv`, and the Workflow `appflare-jobs`
 * (`<name>-jobs` under another name, since Workflow names are account-wide).
 */

/** The manager's default Worker name, and the name its release is built under. */
export const DEFAULT_WORKER_NAME = "appflare";

/**
 * Lowercase letters, digits and inner dashes, at most 58 characters, so
 * `<name>.<subdomain>.workers.dev` stays a valid DNS label and the derived
 * names stay within Cloudflare's limits (as packages/cli/src/names.ts).
 */
export const workerNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/, "a Worker name");

export function d1NameFor(workerName: string): string {
  return workerName;
}

/** The title wrangler would give the KV namespace of binding `KV`. */
export function kvTitleFor(workerName: string): string {
  return `${workerName}-kv`;
}

/**
 * The Workflow an installation named `name` uses for the release's
 * `workflowName` (built under `releaseWorkerName`): the release's own name
 * under the default name, else the name with the release's prefix replaced.
 */
export function workflowNameFor(
  workflowName: string,
  releaseWorkerName: string,
  name: string,
): string {
  if (name === releaseWorkerName) return workflowName;
  const prefix = `${releaseWorkerName}-`;
  return `${name}-${workflowName.startsWith(prefix) ? workflowName.slice(prefix.length) : workflowName}`;
}

/** The manager's Workflow, before a release is chosen (every release so far uses it). */
export const MANAGER_WORKFLOW_NAME = "appflare-jobs";

export function workersDevAddress(workerName: string, subdomain: string): string {
  return `https://${workerName}.${subdomain}.workers.dev`;
}

/** A DNS label in Punycode: letters, digits and inner hyphens, 1 to 63 long. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * The most labels a hostname may have: the zone lookup asks once per parent
 * name, so this bounds what one request spends finding it.
 */
export const MAX_HOSTNAME_LABELS = 10;

/**
 * The hostname as Cloudflare stores it (lower case, no trailing dot,
 * international names in Punycode), or null when it is not a plain hostname
 * a custom domain can be (no wildcard, scheme, port or path).
 */
export function normalizeHostname(input: string): string | null {
  const typed = input.trim().toLowerCase().replace(/\.$/, "");
  if (typed.length === 0 || typed.includes("*") || /[/:?#@\s\\]/.test(typed)) return null;
  let hostname: string;
  try {
    hostname = new URL(`https://${typed}/`).hostname;
  } catch {
    return null;
  }
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    labels.length < 2 ||
    labels.length > MAX_HOSTNAME_LABELS ||
    !labels.every((l) => LABEL.test(l))
  ) {
    return null;
  }
  return hostname;
}

/**
 * The names a hostname's zone can have, longest first: the hostname itself
 * and each parent with at least two labels (`a.b.example.com`,
 * `b.example.com`, `example.com`). At most {@link MAX_HOSTNAME_LABELS} - 1.
 */
export function parentNames(hostname: string): string[] {
  const labels = hostname.split(".");
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

/** Wildcard records looked at for a hostname, nearest first. */
const MAX_WILDCARDS = 3;

/**
 * The wildcard record names that may answer for `hostname` in zone
 * `zoneName`: `*.<parent>` for each parent from the hostname's own up to
 * the zone apex, nearest first. None for the apex itself.
 */
export function wildcardNames(hostname: string, zoneName: string): string[] {
  const zone = zoneName.toLowerCase();
  if (hostname === zone || !hostname.endsWith(`.${zone}`)) return [];
  const out: string[] = [];
  for (const parent of parentNames(hostname).slice(1)) {
    out.push(`*.${parent}`);
    if (parent === zone) break;
  }
  return out.slice(0, MAX_WILDCARDS);
}

/**
 * Whether a Workers route pattern (`host/path`, `*` anywhere in the host)
 * catches requests to `hostname`, on any path.
 */
export function routeMatchesHostname(pattern: string, hostname: string): boolean {
  const withoutScheme = pattern.replace(/^https?:\/\//i, "");
  const host = (withoutScheme.split("/")[0] ?? "").toLowerCase().replace(/:\d+$/, "");
  if (host.length === 0) return false;
  const regex = new RegExp(
    `^${host
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return regex.test(hostname);
}
