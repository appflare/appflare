import { createDb } from "../db/client";
import { deleteSettings, readSettings, SETTING, writeSettings } from "../db/settings";

/**
 * Cloudflare Access protection as stored in `settings`. Present only while it
 * is on: turning it on writes every row at once, turning it off deletes them,
 * together with the "Sign in with Cloudflare Access" switch.
 */
export interface AccessConfig {
  /** The self-hosted Access application protecting the manager's hostname. */
  appId: string;
  /** Its application-scoped allow policy listing the admins' emails. */
  policyId: string;
  /** The application that lets `/api/health` through; null if none was made. */
  healthAppId: string | null;
  /** The application audience tag: the `aud` every accepted token must carry. */
  aud: string;
  /** `<team>.cloudflareaccess.com`: the token issuer and the signing keys' host. */
  teamDomain: string;
  /** The protected hostname. */
  domain: string;
  /** ISO 8601 */
  enabledAt: string;
}

const KEYS = [
  SETTING.accessAppId,
  SETTING.accessPolicyId,
  SETTING.accessHealthAppId,
  SETTING.accessAud,
  SETTING.accessTeamDomain,
  SETTING.accessDomain,
  SETTING.accessEnabledAt,
] as const;

/**
 * The stored protection, or null when it is off. A row set that is only
 * partly present (never written that way) counts as on as long as the values
 * the request check needs exist, so a damaged row set fails closed rather than
 * silently turning protection off. The "Sign in with Cloudflare Access" row
 * is not one of them: alone, it leaves protection off.
 */
export async function readAccessConfig(d1: D1Database): Promise<AccessConfig | null> {
  return configFrom(await readSettings(createDb(d1), KEYS));
}

/**
 * The stored protection and whether "Sign in with Cloudflare Access" is on,
 * in one read. The switch counts only while protection is on.
 */
export async function readAccessSignInState(
  d1: D1Database,
): Promise<{ config: AccessConfig | null; signInEnabled: boolean }> {
  const s = await readSettings(createDb(d1), [...KEYS, SETTING.accessSignInEnabledAt]);
  const config = configFrom(s);
  return { config, signInEnabled: config !== null && (s.access_sign_in_enabled_at ?? "") !== "" };
}

/** Turns "Sign in with Cloudflare Access" on (stamped with `now`) or off. */
export async function writeAccessSignIn(
  d1: D1Database,
  enabled: boolean,
  now: Date = new Date(),
): Promise<void> {
  const db = createDb(d1);
  if (enabled) {
    await writeSettings(db, { [SETTING.accessSignInEnabledAt]: now.toISOString() }, now);
  } else {
    await deleteSettings(db, [SETTING.accessSignInEnabledAt]);
  }
}

function configFrom(s: Partial<Record<(typeof KEYS)[number], string>>): AccessConfig | null {
  const anyPresent = KEYS.some((key) => (s[key] ?? "") !== "");
  if (!anyPresent) return null;
  return {
    appId: s.access_app_id ?? "",
    policyId: s.access_policy_id ?? "",
    healthAppId: s.access_health_app_id || null,
    aud: s.access_aud ?? "",
    teamDomain: s.access_team_domain ?? "",
    domain: s.access_domain ?? "",
    enabledAt: s.access_enabled_at ?? "",
  };
}

export async function writeAccessConfig(
  d1: D1Database,
  config: AccessConfig,
  now: Date = new Date(),
): Promise<void> {
  await writeSettings(
    createDb(d1),
    {
      [SETTING.accessAppId]: config.appId,
      [SETTING.accessPolicyId]: config.policyId,
      [SETTING.accessHealthAppId]: config.healthAppId ?? "",
      [SETTING.accessAud]: config.aud,
      [SETTING.accessTeamDomain]: config.teamDomain,
      [SETTING.accessDomain]: config.domain,
      [SETTING.accessEnabledAt]: config.enabledAt,
    },
    now,
  );
}

/** Removes the protection and the "Sign in with Cloudflare Access" switch with it. */
export async function clearAccessConfig(d1: D1Database): Promise<void> {
  await deleteSettings(createDb(d1), [...KEYS, SETTING.accessSignInEnabledAt]);
}
