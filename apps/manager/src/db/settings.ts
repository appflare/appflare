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
  /**
   * JSON `{ hash, expiresAt }`: the setup claim issued to the browser that
   * connected Cloudflare before any user existed (server/setup.server.ts).
   * Only that browser may create the owner. Deleted once the owner exists.
   */
  setupClaim: "setup_claim",
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
   * The account's Workers plan as an admin stated it, `free` or `paid`. A
   * plan the capability probes detect wins over it; it applies when they
   * cannot tell (the token has no "Billing: Read"). Absent means free.
   */
  accountPlan: "account_plan",
  /**
   * JSON: what the capability probes last found (R2, Containers, Workers
   * plan) and when (capabilities/). Written at token save, on "Re-check",
   * and once a day by the cron.
   */
  accountCapabilities: "account_capabilities",
  /**
   * Anonymous usage data (telemetry/). `telemetry` is `on` or `off`; absent
   * means no admin has changed it, which is on.
   */
  telemetry: "telemetry",
  /**
   * ISO 8601 time the usage-data notice was first shown for this manager:
   * the last setup screen, the home page notice dismissed, or a choice in
   * Settings. While absent, admins see the notice on the home page.
   */
  telemetryNoticeAt: "telemetry_notice_at",
  /** The random id every event is tied to (a UUIDv4). Kept when usage data is turned off. */
  telemetryInstallId: "telemetry_install_id",
  /** Epoch ms up to which job starts and ends have been reported. */
  telemetryCursor: "telemetry_cursor",
  /** UTC day (`YYYY-MM-DD`) of the last heartbeat sent. */
  telemetryHeartbeatDay: "telemetry_heartbeat_day",
  /** `YYYY-MM-DD <role>`: the last UTC day the manager was opened, and the first opener's role. */
  telemetryOpenedDay: "telemetry_opened_day",
  /** UTC day of the last "manager opened" event sent. */
  telemetryOpenedSentDay: "telemetry_opened_sent_day",
  /** `1` once "manager setup completed" was sent; `skipped` when it never will be. */
  telemetrySetupSent: "telemetry_setup_sent",
  /**
   * Automatic updates (auto-update/), `on` or `off`; absent means off.
   * `auto_update_apps` is the default of every install left on "Use the
   * account default"; `auto_update_manager` covers Appflare itself.
   */
  autoUpdateApps: "auto_update_apps",
  autoUpdateManager: "auto_update_manager",
  /**
   * JSON: the external domains gateway (gateway/gateway.server.ts): its zone
   * and what Appflare created there (DNS record, fallback origin, KV
   * namespace, Worker, route), so turning it off removes exactly that.
   * Written as each piece is created; absent when there is no gateway.
   */
  externalDomainsGateway: "external_domains_gateway",
  /** ISO 8601 time the owner last rotated `BETTER_AUTH_SECRET` (danger/). */
  authSecretRotatedAt: "auth_secret_rotated_at",
  /**
   * ISO 8601 time "Remove Appflare from this account" started; present only
   * while it runs (danger/removal-flag.ts). No job starts while it is set.
   */
  removalInProgress: "removal_in_progress",
  /**
   * ISO 8601 time an admin dismissed the home page's "Clean up the deploy
   * copy" card (deploy-button/). Shown only on managers deployed with the
   * "Deploy to Cloudflare" button, and only until then.
   */
  deployCopyDismissedAt: "deploy_copy_dismissed_at",
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
