import {
  AccessCertsError,
  type AccessIdentityProvider,
  type AccessPolicyArgs,
  accessAppCoverage,
  CloudflareApiError,
  type CloudflareClient,
  type FetchLike,
  fetchAccessCerts,
  isAccessTeamDomain,
} from "@appflare/cf-api";
import { hasRole } from "../auth/roles";
import { createDb } from "../db/client";
import { user } from "../db/schema";
import { releaseSettingsLock, tryAcquireSettingsLock } from "../db/settings-lock";
import {
  type AccessConfig,
  clearAccessConfig,
  readAccessConfig,
  writeAccessConfig,
} from "./config";
import { ACCESS_MESSAGES } from "./messages";
import { accessAppName } from "./recovery";

/**
 * Turning Cloudflare Access protection on and off, and keeping its policy in
 * step with the manager's admins. Framework-free: `server/access.functions.ts`
 * binds it to the request, the session, and the manager's own API client.
 *
 * On: a self-hosted Access application for the manager's hostname with one
 * allow policy listing every admin's email, and a second application for
 * `<hostname>/api/health` with a bypass policy so health checks keep working
 * without a sign-in. Their ids, the audience tag, and the team domain go into
 * `settings`, and from then on every request must carry a valid Access token.
 * Off: both applications are deleted, then the settings rows.
 */

export interface AccessToggleDeps {
  db: D1Database;
  client: CloudflareClient;
  /** The hostname the manager is being used on (the request's). */
  hostname: string;
  /** The admin making the change: always in the allow policy. */
  actorEmail: string;
  /** Fetch for the team's signing keys (tests). */
  fetch?: FetchLike;
  now?: () => Date;
}

export type AccessProblem =
  | "apps-permission"
  | "organization-permission"
  | "no-organization"
  | "app-exists"
  | "unsupported-host";

export interface AccessProblemResult {
  ok: false;
  problem: AccessProblem;
  message: string;
}

export interface AccessReady {
  ok: true;
  hostname: string;
  teamDomain: string;
  /** Who the allow policy will let in. */
  adminEmails: string[];
  /** The organization's login methods, as the dashboard names them. */
  loginMethods: string[];
}

export type AccessCheck = AccessReady | AccessProblemResult;

export type EnableAccessResult =
  | { ok: true; hostname: string; teamDomain: string; adminEmails: string[] }
  | AccessProblemResult;

/** A failure after checks passed. Messages never contain the API token. */
export class AccessToggleError extends Error {
  override name = "AccessToggleError";
}

export { ACCESS_MESSAGES };

const LOCK_KEY = "access_lock";
const LOCK_TTL_MS = 60_000;

/** Access tokens (and the sign-in) last this long. */
export const ACCESS_SESSION_DURATION = "24h";

export function adminPolicy(emails: readonly string[]): AccessPolicyArgs {
  return {
    name: "Appflare admins",
    decision: "allow",
    include: emails.map((email) => ({ email: { email } })),
    precedence: 1,
  };
}

export const HEALTH_POLICY: AccessPolicyArgs = {
  name: "Appflare health check",
  decision: "bypass",
  include: [{ everyone: {} }],
  precedence: 1,
};

/** Emails of every admin who is not banned, lower-cased, sorted, unique. */
export async function listAdminEmails(d1: D1Database): Promise<string[]> {
  const rows = await createDb(d1)
    .select({ email: user.email, role: user.role, banned: user.banned })
    .from(user);
  const emails = rows
    .filter((row) => hasRole(row.role, "admin") && row.banned !== true)
    .map((row) => row.email.trim().toLowerCase());
  return [...new Set(emails)].sort();
}

/** The allow list: every admin, and always the admin making the change. */
async function policyEmails(d1: D1Database, actorEmail: string): Promise<string[]> {
  const emails = new Set(await listAdminEmails(d1));
  emails.add(actorEmail.trim().toLowerCase());
  return [...emails].sort();
}

/**
 * A hostname Access can protect: a DNS name with at least one dot, not an IP
 * address or `localhost` (local development).
 */
export function isProtectableHostname(hostname: string): boolean {
  if (!hostname.includes(".")) return false;
  if (/^[\d.]+$/.test(hostname) || hostname.startsWith("[")) return false;
  return /^[a-z0-9.-]+$/i.test(hostname);
}

function isForbidden(error: unknown): boolean {
  return error instanceof CloudflareApiError && (error.status === 403 || error.status === 401);
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

function problem(problem: AccessProblem, message: string): AccessProblemResult {
  return { ok: false, problem, message };
}

const LOGIN_METHOD_NAMES: Record<string, string> = {
  onetimepin: "One-time PIN (a code sent by email)",
  cloudflare: "Cloudflare account",
  google: "Google",
  "google-apps": "Google Workspace",
  github: "GitHub",
  azureAD: "Microsoft Entra ID",
  okta: "Okta",
  onelogin: "OneLogin",
  saml: "SAML",
  oidc: "OpenID Connect",
};

export function loginMethodName(idp: AccessIdentityProvider): string {
  const base = LOGIN_METHOD_NAMES[idp.type] ?? idp.type;
  if (idp.type === "cloudflare" && idp.config?.restrict_to_account_members === true) {
    return `${base} (members of this Cloudflare account only)`;
  }
  // The provider's own name only when it adds something: "One-time PIN" says
  // nothing more than the type, "GitHub (work)" names the type itself.
  const name = idp.name?.trim();
  if (!name) return base;
  const b = base.toLowerCase();
  const n = name.toLowerCase();
  if (b.includes(n)) return base;
  if (n.includes(b)) return name;
  return `${base}: ${name}`;
}

/**
 * Everything that can be checked before creating anything: the hostname, the
 * token's Access permissions, the organization, and that no application
 * already protects the hostname. Changes nothing.
 */
export async function checkAccessPrerequisites(deps: AccessToggleDeps): Promise<AccessCheck> {
  const hostname = deps.hostname.toLowerCase();
  if (!isProtectableHostname(hostname)) {
    return problem("unsupported-host", ACCESS_MESSAGES.unsupportedHost(hostname));
  }

  let apps: Awaited<ReturnType<CloudflareClient["access"]["listApps"]>>;
  try {
    apps = await deps.client.access.listApps();
  } catch (error) {
    if (isForbidden(error)) return problem("apps-permission", ACCESS_MESSAGES.appsPermission);
    throw error;
  }

  let teamDomain: string;
  try {
    teamDomain = (await deps.client.access.getOrganization()).auth_domain;
  } catch (error) {
    if (isNotFound(error)) return problem("no-organization", ACCESS_MESSAGES.noOrganization);
    if (isForbidden(error)) {
      return problem("organization-permission", ACCESS_MESSAGES.organizationPermission);
    }
    throw error;
  }
  if (!isAccessTeamDomain(teamDomain)) {
    throw new AccessToggleError(
      `The Zero Trust organization's team domain "${teamDomain}" is not a cloudflareaccess.com domain, which Appflare cannot verify tokens from.`,
    );
  }

  // An application may protect the hostname through `domain` or through one
  // of several destinations (then `domain` is null), so read them all.
  const existing = apps.find((app) => accessAppCoverage(app).uris.includes(hostname));
  if (existing !== undefined) {
    return problem("app-exists", ACCESS_MESSAGES.appExists(existing.name ?? existing.id));
  }

  // Login methods only inform the warning; a token that cannot list them
  // (the same permission as the organization) was already refused above.
  let loginMethods: string[] = [];
  try {
    loginMethods = (await deps.client.access.listIdentityProviders()).map(loginMethodName);
  } catch (error) {
    if (!(error instanceof CloudflareApiError)) throw error;
  }

  return {
    ok: true,
    hostname,
    teamDomain,
    adminEmails: await policyEmails(deps.db, deps.actorEmail),
    loginMethods,
  };
}

/**
 * Turns protection on. Re-runs every check, then creates the applications and
 * policies; if any later step fails, whatever was created is deleted again and
 * nothing is stored, so a failed attempt never leaves the manager half on.
 */
export async function enableAccess(deps: AccessToggleDeps): Promise<EnableAccessResult> {
  return withLock(deps.db, async () => {
    if ((await readAccessConfig(deps.db)) !== null) {
      throw new AccessToggleError(ACCESS_MESSAGES.alreadyOn);
    }
    const check = await checkAccessPrerequisites(deps);
    if (!check.ok) return check;
    const { hostname, teamDomain, adminEmails } = check;

    const created: string[] = [];
    try {
      const app = await deps.client.access.createApp({
        type: "self_hosted",
        name: accessAppName(hostname),
        domain: hostname,
        session_duration: ACCESS_SESSION_DURATION,
        app_launcher_visible: false,
      });
      created.push(app.id);
      const policy = await deps.client.access.createPolicy(app.id, adminPolicy(adminEmails));

      const healthApp = await deps.client.access.createApp({
        type: "self_hosted",
        name: `Appflare health check (${hostname})`,
        domain: `${hostname}/api/health`,
        app_launcher_visible: false,
      });
      created.push(healthApp.id);
      await deps.client.access.createPolicy(healthApp.id, HEALTH_POLICY);

      // The keys must be reachable before any request depends on them.
      try {
        await fetchAccessCerts(teamDomain, { fetch: deps.fetch });
      } catch (error) {
        if (error instanceof AccessCertsError) {
          throw new AccessToggleError(ACCESS_MESSAGES.keysUnreachable);
        }
        throw error;
      }

      const now = (deps.now ?? (() => new Date()))();
      const config: AccessConfig = {
        appId: app.id,
        policyId: policy.id,
        healthAppId: healthApp.id,
        aud: app.aud,
        teamDomain,
        domain: hostname,
        enabledAt: now.toISOString(),
      };
      await writeAccessConfig(deps.db, config, now);
    } catch (error) {
      await deleteApps(deps.client, created.reverse());
      if (isForbidden(error)) throw new AccessToggleError(ACCESS_MESSAGES.appsPermission);
      throw error;
    }
    return { ok: true, hostname, teamDomain, adminEmails };
  });
}

export type DisableAccessResult = { ok: true; wasOn: boolean };

/**
 * Turns protection off: deletes both applications (already gone counts as
 * deleted), then the settings. If a deletion fails nothing is cleared, so the
 * manager never stops checking tokens while Access might still send them.
 */
export async function disableAccess(
  deps: Pick<AccessToggleDeps, "db" | "client">,
): Promise<DisableAccessResult> {
  return withLock(deps.db, async () => {
    const config = await readAccessConfig(deps.db);
    if (config === null) return { ok: true, wasOn: false };
    const ids = [config.healthAppId, config.appId].filter(
      (id): id is string => id !== null && id.length > 0,
    );
    for (const id of ids) {
      try {
        await deps.client.access.deleteApp(id);
      } catch (error) {
        if (isNotFound(error)) continue;
        if (isForbidden(error)) throw new AccessToggleError(ACCESS_MESSAGES.appsPermission);
        throw error;
      }
    }
    await clearAccessConfig(deps.db);
    return { ok: true, wasOn: true };
  });
}

export type SyncAccessResult =
  | { ok: true; on: false }
  | { ok: true; on: true; adminEmails: string[] };

/**
 * Rewrites the allow policy to list exactly the current admins (plus the
 * admin making the change, when there is one). A no-op while protection is off.
 */
export async function syncAccessAdmins(
  deps: Pick<AccessToggleDeps, "db" | "client"> & { actorEmail?: string },
): Promise<SyncAccessResult> {
  const config = await readAccessConfig(deps.db);
  if (config === null) return { ok: true, on: false };
  const adminEmails =
    deps.actorEmail === undefined
      ? await listAdminEmails(deps.db)
      : await policyEmails(deps.db, deps.actorEmail);
  if (adminEmails.length === 0) {
    // An empty include list would lock everyone out; never write one.
    throw new AccessToggleError("There are no admins to allow through Cloudflare Access.");
  }
  try {
    await deps.client.access.updatePolicy(config.appId, config.policyId, adminPolicy(adminEmails));
  } catch (error) {
    if (isNotFound(error)) throw new AccessToggleError(ACCESS_MESSAGES.policyMissing);
    if (isForbidden(error)) throw new AccessToggleError(ACCESS_MESSAGES.appsPermission);
    throw error;
  }
  return { ok: true, on: true, adminEmails };
}

/** Best effort: removes applications a failed attempt created. */
async function deleteApps(client: CloudflareClient, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      await client.access.deleteApp(id);
    } catch (error) {
      console.error("access: could not remove an application after a failed attempt", {
        appId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Before Appflare moves to `hostname`: the protection to move along, or null
 * when it is off. Refuses (AccessToggleError), before anything changes, when
 * the token cannot manage Access applications, when the manager's
 * application is gone, or when another application already protects
 * `hostname`. Reads one list of applications.
 */
export async function checkAccessMove(
  deps: Pick<AccessToggleDeps, "db" | "client">,
  hostname: string,
): Promise<AccessConfig | null> {
  const config = await readAccessConfig(deps.db);
  if (config === null) return null;
  let apps: Awaited<ReturnType<CloudflareClient["access"]["listApps"]>>;
  try {
    apps = await deps.client.access.listApps();
  } catch (error) {
    if (isForbidden(error)) throw new AccessToggleError(ACCESS_MESSAGES.appsPermission);
    throw error;
  }
  if (!apps.some((app) => app.id === config.appId)) {
    throw new AccessToggleError(ACCESS_MESSAGES.appMissing);
  }
  const ours = new Set([config.appId, config.healthAppId]);
  const target = hostname.toLowerCase();
  const takenUris = [target, `${target}/api/health`];
  const taken = apps.find((app) => {
    if (ours.has(app.id)) return false;
    // Paths compared in lower case, as before: a false conflict is cheaper
    // than a missed one.
    const uris = accessAppCoverage(app).uris.map((uri) => uri.toLowerCase());
    return takenUris.some((uri) => uris.includes(uri));
  });
  if (taken !== undefined) {
    throw new AccessToggleError(ACCESS_MESSAGES.appExists(taken.name ?? taken.id));
  }
  return config;
}

/**
 * Points both Access applications at `hostname` (`PUT /access/apps/{id}`,
 * each with every setting it was created with), and returns the protection
 * as it then stands. Writes nothing: the caller stores the new `domain`
 * (and `aud`, `policyId`) with the rest of the move. An application keeps
 * its policies; one that answers with none gets its policy again. When the
 * second application cannot be moved, the first is put back before the
 * error is thrown, so both keep protecting the same hostname.
 */
export async function moveAccessApps(
  deps: Pick<AccessToggleDeps, "db" | "client">,
  config: AccessConfig,
  hostname: string,
): Promise<AccessConfig> {
  const { client } = deps;
  const mainApp = (host: string) => ({
    type: "self_hosted" as const,
    name: accessAppName(host),
    domain: host,
    session_duration: ACCESS_SESSION_DURATION,
    app_launcher_visible: false,
  });
  const healthApp = (host: string) => ({
    type: "self_hosted" as const,
    name: `Appflare health check (${host})`,
    domain: `${host}/api/health`,
    app_launcher_visible: false,
  });
  const lostPolicies = (app: { policies?: unknown[] }) =>
    Array.isArray(app.policies) && app.policies.length === 0;

  let moved: Awaited<ReturnType<CloudflareClient["access"]["updateApp"]>>;
  try {
    moved = await client.access.updateApp(config.appId, mainApp(hostname));
  } catch (error) {
    if (isNotFound(error)) throw new AccessToggleError(ACCESS_MESSAGES.appMissing);
    if (isForbidden(error)) throw new AccessToggleError(ACCESS_MESSAGES.appsPermission);
    throw error;
  }
  let policyId = config.policyId;
  const { healthAppId } = config;
  try {
    if (lostPolicies(moved)) {
      policyId = (
        await client.access.createPolicy(config.appId, adminPolicy(await allowList(deps)))
      ).id;
    }
    if (healthAppId !== null) {
      const health = await client.access.updateApp(healthAppId, healthApp(hostname));
      if (lostPolicies(health)) await client.access.createPolicy(healthAppId, HEALTH_POLICY);
    }
  } catch (error) {
    try {
      await client.access.updateApp(config.appId, mainApp(config.domain));
    } catch (putBack) {
      console.error("access: could not put the manager's application back", {
        appId: config.appId,
        error: putBack instanceof Error ? putBack.message : String(putBack),
      });
    }
    if (isForbidden(error)) throw new AccessToggleError(ACCESS_MESSAGES.appsPermission);
    throw error;
  }
  return { ...config, domain: hostname, aud: moved.aud || config.aud, policyId };
}

/** The admins to allow; never empty, since an empty include list would lock everyone out. */
async function allowList(deps: Pick<AccessToggleDeps, "db">): Promise<string[]> {
  const emails = await listAdminEmails(deps.db);
  if (emails.length === 0) {
    throw new AccessToggleError("There are no admins to allow through Cloudflare Access.");
  }
  return emails;
}

/** Runs `run` while holding the lock every Access change takes, so two never interleave. */
export function withAccessLock<T>(db: D1Database, run: () => Promise<T>): Promise<T> {
  return withLock(db, run);
}

async function withLock<T>(db: D1Database, run: () => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID();
  if (!(await tryAcquireSettingsLock(db, LOCK_KEY, owner, LOCK_TTL_MS))) {
    throw new AccessToggleError(ACCESS_MESSAGES.busy);
  }
  try {
    return await run();
  } finally {
    await releaseSettingsLock(db, LOCK_KEY, owner);
  }
}
