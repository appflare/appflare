import { CloudflareApiError, type WorkerVersion } from "@appflare/cf-api";
import { schemaDowngrade } from "../../db/migrate";
import { VERSION_BINDING } from "./plan";

/**
 * The pure decisions of rolling the manager back to one of its own earlier
 * Worker versions: which Appflare release a version runs, which versions the
 * Versions list offers, what the target's preview reports about itself, and
 * whether its code may serve the database as it is now.
 *
 * The rule: the target's code must know every migration the database has.
 * Migrations only add to the schema and older code tolerates a database that
 * is ahead (that is what the home page's downgrade banner explains), but what
 * the newer version added would then be missing, so a rollback across a
 * migration is refused rather than started. The same comparison as the
 * banner's (`schemaDowngrade`) decides it, with the target's own count read
 * from its preview's `/api/health` (`knownSchemaVersion`).
 */

/** How many of the Worker's newest versions the list shows (the API's default page). */
export const MANAGER_VERSIONS_LIMIT = 10;

/** One row of Settings, Appflare updates, Versions. */
export interface ManagerVersionRow {
  /** The Workers version id. */
  id: string;
  /** Cloudflare's running number of the Worker's versions; null when not reported. */
  number: number | null;
  /** ISO 8601; null when not reported. */
  createdOn: string | null;
  /** The Appflare release the version runs (its `APPFLARE_VERSION`); null when it has none. */
  appflareVersion: string | null;
  /** What made the version (`workers/triggered_by`: an upload, a secret change, ...). */
  trigger: string | null;
  /** The version's `workers/message` annotation. */
  message: string | null;
  /** The version serves all traffic now. */
  serving: boolean;
  /** Older than the serving version, so it can be rolled back to. */
  older: boolean;
}

/** The `APPFLARE_VERSION` a version detail (`GET .../versions/{id}`) carries, or null. */
export function appflareVersionOf(version: WorkerVersion): string | null {
  const bindings = version.resources?.bindings;
  if (!Array.isArray(bindings)) return null;
  for (const binding of bindings as unknown[]) {
    if (typeof binding !== "object" || binding === null) continue;
    const { type, name, text } = binding as { type?: unknown; name?: unknown; text?: unknown };
    if (type === "plain_text" && name === VERSION_BINDING && typeof text === "string") return text;
  }
  return null;
}

/** The names of a version detail's bindings. */
export function bindingNamesOf(version: WorkerVersion): string[] {
  const bindings = version.resources?.bindings;
  if (!Array.isArray(bindings)) return [];
  return (bindings as unknown[]).flatMap((b) => {
    const name = typeof b === "object" && b !== null ? (b as { name?: unknown }).name : undefined;
    return typeof name === "string" ? [name] : [];
  });
}

/** Whether Cloudflare serves a preview URL for the version (`metadata.has_preview`). */
export function hasPreview(version: WorkerVersion): boolean {
  return version.metadata?.has_preview === true;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The list's rows, newest first: each listed version with the Appflare
 * release its detail names, which one serves, and which are older than it.
 */
export function managerVersionRows(
  listed: readonly WorkerVersion[],
  details: ReadonlyMap<string, WorkerVersion>,
  servingId: string | null,
  servingNumber: number | null,
): ManagerVersionRow[] {
  return listed
    .map((v) => {
      const detail = details.get(v.id);
      const number = typeof v.number === "number" ? v.number : null;
      return {
        id: v.id,
        number,
        createdOn: text(v.metadata?.created_on),
        appflareVersion: detail === undefined ? null : appflareVersionOf(detail),
        trigger: text(v.annotations?.["workers/triggered_by"]),
        message: text(v.annotations?.["workers/message"]),
        serving: v.id === servingId,
        older: v.id !== servingId && isOlder(number, servingNumber),
      };
    })
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
}

function isOlder(number: number | null, servingNumber: number | null): boolean {
  return number !== null && servingNumber !== null && number < servingNumber;
}

/** What a manager version's `/api/health` reports about itself. */
export interface ManagerHealthReport {
  version: string;
  db: string | null;
  /** Null from versions built before the health report carried it. */
  knownSchemaVersion: number | null;
}

/** Reads a `/api/health` body; null when it is not a manager's health report. */
export function readManagerHealth(body: string): ManagerHealthReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const report = parsed as { version?: unknown; db?: unknown; knownSchemaVersion?: unknown };
  if (typeof report.version !== "string") return null;
  const known = report.knownSchemaVersion;
  return {
    version: report.version,
    db: typeof report.db === "string" ? report.db : null,
    knownSchemaVersion: typeof known === "number" && Number.isInteger(known) ? known : null,
  };
}

/**
 * Why the target version may not serve the database as it is, or null when
 * it may. `recorded` is the database's `schema_version`; `known` the
 * target's `knownSchemaVersion` (null when its health report has none).
 */
export function rollbackSchemaRefusal(
  target: string,
  recorded: number,
  known: number | null,
): string | null {
  if (known === null) {
    return `Appflare ${target} does not report which database schema its code was written for (it was built before versions reported it), so Appflare cannot tell whether it works with the database as it is. Roll back from the Worker's Deployments page in the Cloudflare dashboard if you must.`;
  }
  const downgrade = schemaDowngrade(recorded, known);
  if (downgrade === null) return null;
  return `Appflare ${target} was written for database schema ${downgrade.known}, and the database is at schema ${downgrade.recorded}: a newer version migrated it since. The database is not rolled back, so that version's code is older than the database. Update Appflare instead, or pick a version from the same release as the one serving.`;
}

/** Cloudflare's code for a deployment refused because secrets changed since the version (wrangler's `versions rollback` reads it too). */
export const SECRETS_CHANGED_CODE = 10220;

/**
 * The secrets Cloudflare says changed since the version, when it refused
 * the deployment for that reason (an empty list when it named none); null
 * for any other error.
 */
export function changedSecretsOf(error: unknown): string[] | null {
  if (!(error instanceof CloudflareApiError)) return null;
  const refusal = error.errors.find((e) => e.code === SECRETS_CHANGED_CODE);
  if (refusal === undefined) return null;
  const marker = "The following secrets have changed:";
  const at = refusal.message.indexOf(marker);
  if (at < 0) return [];
  return refusal.message
    .slice(at + marker.length)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
