import { inArray, sql } from "drizzle-orm";
import type { Database } from "./client";
import { settings } from "./schema";

/**
 * Keys of the `settings` rows read and written through this module: what the
 * Cloudflare token step discovered (account id, Worker name), caches, and the
 * self-update history. Other rows (`schema_version`, locks) belong to their
 * own modules.
 */
export const SETTING = {
  accountId: "account_id",
  accountName: "account_name",
  workerName: "worker_name",
  /** "1" once `CF_API_TOKEN` has been written to the Worker by the setup wizard. */
  cfTokenConfigured: "cf_token_configured",
  /** ISO 8601 time of the last successful verify-and-store. */
  cfTokenVerifiedAt: "cf_token_verified_at",
  /** The account's workers.dev subdomain (`<name>.<subdomain>.workers.dev`), cached by the install job. */
  accountSubdomain: "account_subdomain",
  /**
   * JSON array of the manager's self-updates, oldest first:
   * `{ version, from, jobId, workerVersionId, at }`. Appended by the
   * self-update job's last step.
   */
  managerVersionHistory: "manager_version_history",
  /**
   * Cloudflare Access protection, all set together when it is turned on and
   * all removed when it is turned off. `access_aud` and `access_team_domain`
   * are what every request's `Cf-Access-Jwt-Assertion` is checked against.
   */
  accessAppId: "access_app_id",
  accessPolicyId: "access_policy_id",
  /** The second application that lets `/api/health` through without a sign-in. */
  accessHealthAppId: "access_health_app_id",
  accessAud: "access_aud",
  accessTeamDomain: "access_team_domain",
  /** The hostname the Access application protects. */
  accessDomain: "access_domain",
  /** ISO 8601 time Access protection was turned on. */
  accessEnabledAt: "access_enabled_at",
  /**
   * The account's Workers plan as an admin stated it, `free` or `paid`;
   * absent means free. Cloudflare's API offers no plan signal to read.
   */
  accountPlan: "account_plan",
} as const;

export type SettingKey = (typeof SETTING)[keyof typeof SETTING];

export async function readSettings<K extends SettingKey>(
  db: Database,
  keys: readonly K[],
): Promise<Partial<Record<K, string>>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...keys]));
  const out: Partial<Record<K, string>> = {};
  for (const row of rows) out[row.key as K] = row.value;
  return out;
}

/** Upserts every given row in one statement. */
export async function writeSettings(
  db: Database,
  values: Partial<Record<SettingKey, string>>,
  now: Date = new Date(),
): Promise<void> {
  const rows = Object.entries(values).flatMap(([key, value]) =>
    value === undefined ? [] : [{ key, value, updated_at: now }],
  );
  if (rows.length === 0) return;
  await db
    .insert(settings)
    .values(rows)
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: sql`excluded.value`, updated_at: sql`excluded.updated_at` },
    });
}

/** Deletes the given rows; missing ones are ignored. */
export async function deleteSettings(db: Database, keys: readonly SettingKey[]): Promise<void> {
  if (keys.length === 0) return;
  await db.delete(settings).where(inArray(settings.key, [...keys]));
}

export async function isCfTokenConfigured(db: Database): Promise<boolean> {
  const row = await readSettings(db, [SETTING.cfTokenConfigured]);
  return row.cf_token_configured === "1";
}
