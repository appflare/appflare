import {
  type AccessApp,
  type AccessReusablePolicyArgs,
  type AccessServiceToken,
  type AccessServiceTokenWithSecret,
  CloudflareApiError,
  type CloudflareClient,
  type CreateAccessAppArgs,
  isServiceTokenInUse,
} from "@appflare/cf-api";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { createDb } from "../db/client";
import { install_access, resources, user } from "../db/schema";
import { deleteSettings, readSettings, SETTING, writeSettings } from "../db/settings";
import { ACCESS_APP_KIND, ACCESS_SERVICE_TOKEN_KIND } from "../installs/resource-kinds";
import { INSTALL_ACCESS_MESSAGES, USERS_POLICY_NAME } from "./messages";
import { openServiceTokenSecret, sealServiceTokenSecret } from "./service-token-secret";
import { AccessToggleError, withAccessLock } from "./toggle.server";

/**
 * Cloudflare Access for installed apps: what the protection of each install
 * needs besides its Access application.
 *
 * - One reusable "Appflare users" policy (allow) that every protected app
 *   references: one email rule per Appflare user who is not banned, members
 *   included. The manager's own protection lets only admins in
 *   (toggle.server.ts); an app is for everyone who uses Appflare.
 * - Per install, its own service token, which only the manager's health
 *   checks of that install use (probe-credentials.server.ts), named by an
 *   `non_identity` policy on that install's Access application alone. A
 *   Worker behind Access never sees the token (Access strips the headers),
 *   but one that is not (never protected, or its application deleted in the
 *   dashboard) receives them as sent; with one token per install, a token
 *   that reaches an app's code opens nothing but that app.
 *
 * The install's Access application itself is made and kept in step by
 * protect.server.ts, which composes these helpers.
 *
 * The users policy's id is a `settings` row; each install's token is an
 * `install_access` row (secret sealed, see service-token-secret.ts) and an
 * `access_service_token` resource. Names are deterministic, so a token or
 * policy whose id could not be stored is found again by name and adopted
 * instead of made twice.
 *
 * Locking: every change to Access runs under `withAccessLock`. The helpers
 * the protect and unprotect paths compose (`ensureAppAccessUsersPolicy`,
 * `ensureInstallServiceToken`, `rotateInstallServiceToken`,
 * `deleteInstallServiceToken`, `removeAppAccessUsersPolicyIfUnused`,
 * `removeInstallAccess`) expect the caller to hold it; the ones that run
 * on their own (`syncAppAccessUsers`, the cron's `resyncAppAccessUsersIfFailed`
 * and `renewInstallServiceTokens`, `releaseAppAccessForRemoval`) take it
 * themselves.
 */

export interface InstallAccessDeps {
  db: D1Database;
  client: CloudflareClient;
  /** `BETTER_AUTH_SECRET`: token secrets are sealed with a key derived from it. */
  authSecret: string | undefined;
  now?: () => Date;
}

/** An install's row, as stored. `sealedSecret` never leaves the manager except to Access. */
export interface InstallAccessRecord {
  installId: string;
  /** Set once the install's Access application exists: the install is protected by Appflare. */
  accessAppId: string | null;
  probesPolicyId: string | null;
  tokenId: string;
  clientId: string;
  sealedSecret: string;
  expiresAt: Date | null;
}

/** Cloudflare's default validity; the cron refreshes a token well before it ends. */
export const SERVICE_TOKEN_DURATION = "8760h";
/** The cron refreshes a token once it has less than this left. */
export const SERVICE_TOKEN_REFRESH_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a rotated token's previous secret keeps working. */
export const ROTATION_GRACE_MS = 5 * 60 * 1000;
/** At most this many tokens are refreshed or rotated per cron run (one call each). */
export const RENEWALS_PER_RUN = 10;

/** The install's token, by a name that says what it is and finds it again. */
export function serviceTokenName(installId: string): string {
  return `Appflare health checks ${installId}`;
}

/** The name of the `non_identity` policy on the install's Access application. */
export function probesPolicyName(installId: string): string {
  return `Appflare health checks ${installId}`;
}

export { INSTALL_ACCESS_MESSAGES, USERS_POLICY_NAME };

export function usersPolicy(emails: readonly string[]): AccessReusablePolicyArgs {
  return {
    name: USERS_POLICY_NAME,
    decision: "allow",
    include: emails.map((email) => ({ email: { email } })),
  };
}

/** The policy on the install's Access application that lets its token through. */
export function probesPolicy(installId: string, tokenId: string): AccessReusablePolicyArgs {
  return {
    name: probesPolicyName(installId),
    decision: "non_identity",
    include: [{ service_token: { token_id: tokenId } }],
  };
}

function isForbidden(error: unknown): boolean {
  return error instanceof CloudflareApiError && (error.status === 403 || error.status === 401);
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

/** Runs one Cloudflare call, turning a refusal of the token into `message`. */
async function asAccessError<T>(message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isForbidden(error)) throw new AccessToggleError(message);
    throw error;
  }
}

const nowOf = (deps: { now?: () => Date }) => (deps.now ?? (() => new Date()))();

function requireAuthSecret(authSecret: string | undefined): void {
  if (authSecret === undefined || authSecret.length === 0) {
    throw new AccessToggleError(INSTALL_ACCESS_MESSAGES.noAuthSecret);
  }
}

// ---------------------------------------------------------------- records

type Row = typeof install_access.$inferSelect;

function recordOf(row: Row): InstallAccessRecord {
  return {
    installId: row.install_id,
    accessAppId: row.access_app_id,
    probesPolicyId: row.probes_policy_id,
    tokenId: row.token_id,
    clientId: row.token_client_id,
    sealedSecret: row.token_secret,
    expiresAt: row.token_expires_at,
  };
}

export async function readInstallAccess(
  d1: D1Database,
  installId: string,
): Promise<InstallAccessRecord | null> {
  const [row] = await createDb(d1)
    .select()
    .from(install_access)
    .where(eq(install_access.install_id, installId))
    .limit(1);
  return row === undefined ? null : recordOf(row);
}

export async function listInstallAccess(d1: D1Database): Promise<InstallAccessRecord[]> {
  const rows = await createDb(d1).select().from(install_access).orderBy(install_access.install_id);
  return rows.map(recordOf);
}

/** Whether any install is protected by Appflare (has its Access application recorded). */
export async function anyProtectedInstall(d1: D1Database): Promise<boolean> {
  const [row] = await createDb(d1)
    .select({ id: install_access.install_id })
    .from(install_access)
    .where(isNotNull(install_access.access_app_id))
    .limit(1);
  return row !== undefined;
}

/**
 * Records the install's Access application and its token policy once they
 * exist (the install is then protected, and its health checks carry the
 * token), or clears them (null) once the application is gone: then its
 * audience tag, team domain and destinations are cleared too, and its
 * `access_app` resource is marked deleted.
 */
export async function recordInstallProtection(
  d1: D1Database,
  installId: string,
  protection: { accessAppId: string; probesPolicyId: string } | null,
  now: Date = new Date(),
): Promise<void> {
  const orm = createDb(d1);
  const row = orm
    .update(install_access)
    .set({
      access_app_id: protection?.accessAppId ?? null,
      probes_policy_id: protection?.probesPolicyId ?? null,
      ...(protection === null
        ? {
            access_aud: null,
            access_team_domain: null,
            access_destinations_json: null,
            users_policy_id: null,
            access_app_missing_at: null,
          }
        : {}),
      updated_at: now,
    })
    .where(eq(install_access.install_id, installId));
  if (protection !== null) {
    await row;
    return;
  }
  await orm.batch([
    row,
    orm
      .update(resources)
      .set({ deleted_at: now })
      .where(
        and(
          eq(resources.id, accessAppResourceId(installId)),
          eq(resources.install_id, installId),
          isNull(resources.deleted_at),
        ),
      ),
  ]);
}

/** The resource row of the install's Access application (`<install>:access_app:app`). */
export function accessAppResourceId(installId: string): string {
  return `${installId}:${ACCESS_APP_KIND}:app`;
}

/** The resource row of the install's token (`<install>:access_service_token:token`). */
function tokenResourceId(installId: string): string {
  return `${installId}:${ACCESS_SERVICE_TOKEN_KIND}:token`;
}

/** Seals and stores a token Cloudflare just answered with its secret, keeping the protection columns. */
async function storeToken(
  deps: Pick<InstallAccessDeps, "db" | "authSecret" | "now">,
  installId: string,
  token: AccessServiceTokenWithSecret,
): Promise<InstallAccessRecord> {
  const at = nowOf(deps);
  const sealed = await sealServiceTokenSecret(
    deps.authSecret,
    { installId, tokenId: token.id },
    token.client_secret,
  );
  const expiresAt = token.expires_at ? new Date(token.expires_at) : null;
  const expires = expiresAt !== null && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null;
  const orm = createDb(deps.db);
  const tokenColumns = {
    token_id: token.id,
    token_client_id: token.client_id,
    token_secret: sealed,
    token_expires_at: expires,
    updated_at: at,
  };
  await orm.batch([
    orm
      .insert(install_access)
      .values({ install_id: installId, ...tokenColumns, created_at: at })
      .onConflictDoUpdate({ target: install_access.install_id, set: tokenColumns }),
    orm
      .insert(resources)
      .values({
        id: tokenResourceId(installId),
        install_id: installId,
        kind: ACCESS_SERVICE_TOKEN_KIND,
        binding: null,
        name: token.name || serviceTokenName(installId),
        cf_id: token.id,
        created_at: at,
      })
      .onConflictDoUpdate({
        target: resources.id,
        set: { cf_id: token.id, deleted_at: null, retained_at: null },
      }),
  ]);
  const stored = await readInstallAccess(deps.db, installId);
  if (stored === null) throw new Error("the service token could not be recorded");
  return stored;
}

/** Forgets the install's token: its row, and its resource marked deleted. */
async function forgetToken(
  deps: Pick<InstallAccessDeps, "db" | "now">,
  installId: string,
): Promise<void> {
  const orm = createDb(deps.db);
  await orm.batch([
    orm.delete(install_access).where(eq(install_access.install_id, installId)),
    orm
      .update(resources)
      .set({ deleted_at: nowOf(deps) })
      .where(
        and(eq(resources.id, tokenResourceId(installId)), eq(resources.install_id, installId)),
      ),
  ]);
}

async function readable(
  authSecret: string | undefined,
  record: InstallAccessRecord,
): Promise<boolean> {
  return (
    (await openServiceTokenSecret(
      authSecret,
      { installId: record.installId, tokenId: record.tokenId },
      record.sealedSecret,
    )) !== null
  );
}

// ---------------------------------------------------------------- tokens

export type InstallTokenOutcome =
  /** It existed and its secret reads. */
  | "kept"
  | "created"
  /** Found by its name without a stored id (an earlier write was lost), and rotated to learn its secret. */
  | "adopted"
  /** The stored one was gone from Cloudflare (deleted in the dashboard). */
  | "recreated"
  /** The stored secret no longer read (`BETTER_AUTH_SECRET` changed); it has a new one. */
  | "rotated";

export interface InstallTokenReady {
  tokenId: string;
  clientId: string;
  outcome: InstallTokenOutcome;
}

/**
 * Makes sure the install has its own working service token and returns it.
 * Caller holds `withAccessLock`. When a new token replaces a stored one on a
 * protected install, the application's token policy is pointed at it.
 */
export async function ensureInstallServiceToken(
  deps: InstallAccessDeps,
  installId: string,
): Promise<InstallTokenReady> {
  requireAuthSecret(deps.authSecret);
  const { access } = deps.client;
  const record = await readInstallAccess(deps.db, installId);
  const tokens = await asAccessError(INSTALL_ACCESS_MESSAGES.tokensPermission, () =>
    access.listServiceTokens(),
  );
  if (record !== null && tokens.some((t) => t.id === record.tokenId)) {
    if (await readable(deps.authSecret, record)) {
      return { tokenId: record.tokenId, clientId: record.clientId, outcome: "kept" };
    }
    const rotated = await storeToken(
      deps,
      installId,
      await asAccessError(INSTALL_ACCESS_MESSAGES.tokensPermission, () =>
        access.rotateServiceToken(record.tokenId),
      ),
    );
    return { tokenId: rotated.tokenId, clientId: rotated.clientId, outcome: "rotated" };
  }

  const name = serviceTokenName(installId);
  const orphan = tokens.find((t: AccessServiceToken) => t.name === name);
  const answered = await asAccessError(INSTALL_ACCESS_MESSAGES.tokensPermission, () =>
    orphan !== undefined
      ? access.rotateServiceToken(orphan.id)
      : access.createServiceToken({ name, duration: SERVICE_TOKEN_DURATION }),
  );
  const stored = await storeToken(deps, installId, answered);
  const outcome: InstallTokenOutcome =
    record !== null ? "recreated" : orphan !== undefined ? "adopted" : "created";
  if (record !== null && stored.accessAppId !== null && stored.probesPolicyId !== null) {
    const { accessAppId, probesPolicyId } = stored;
    try {
      await asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
        access.updatePolicy(accessAppId, probesPolicyId, probesPolicy(installId, stored.tokenId)),
      );
    } catch (error) {
      // The application or its policy is gone too: protecting again repairs both.
      if (!isNotFound(error)) throw error;
    }
  }
  return { tokenId: stored.tokenId, clientId: stored.clientId, outcome };
}

/** A new secret for the install's token, stored sealed. Caller holds `withAccessLock`. */
export async function rotateInstallServiceToken(
  deps: InstallAccessDeps,
  installId: string,
): Promise<InstallAccessRecord> {
  requireAuthSecret(deps.authSecret);
  const record = await readInstallAccess(deps.db, installId);
  if (record === null) throw new AccessToggleError(INSTALL_ACCESS_MESSAGES.notRecorded);
  try {
    return await storeToken(
      deps,
      installId,
      await asAccessError(INSTALL_ACCESS_MESSAGES.tokensPermission, () =>
        deps.client.access.rotateServiceToken(record.tokenId),
      ),
    );
  } catch (error) {
    if (isNotFound(error)) throw new AccessToggleError(INSTALL_ACCESS_MESSAGES.tokenMissing);
    throw error;
  }
}

/**
 * Deletes the install's token and forgets it (already gone counts as
 * deleted). Delete the install's Access application first: while its policy
 * names the token, Cloudflare refuses (code 12139, `tokenInUse`). Caller
 * holds `withAccessLock`.
 */
export async function deleteInstallServiceToken(
  deps: Pick<InstallAccessDeps, "db" | "client" | "now">,
  installId: string,
): Promise<{ deleted: boolean }> {
  const record = await readInstallAccess(deps.db, installId);
  if (record === null) return { deleted: false };
  try {
    await asAccessError(INSTALL_ACCESS_MESSAGES.tokensPermission, () =>
      deps.client.access.deleteServiceToken(record.tokenId),
    );
  } catch (error) {
    if (isServiceTokenInUse(error)) throw new AccessToggleError(INSTALL_ACCESS_MESSAGES.tokenInUse);
    if (!isNotFound(error)) throw error;
  }
  await forgetToken(deps, installId);
  return { deleted: true };
}

/**
 * Takes Appflare's protection off an install: deletes its Access
 * application (which removes the application's own token policy), then its
 * token, then "Appflare users" when nothing uses it any more. Already gone
 * counts as removed. For unprotecting an app and for uninstalling a
 * protected one. Caller holds `withAccessLock`.
 */
export async function removeInstallAccess(
  deps: Pick<InstallAccessDeps, "db" | "client" | "now">,
  installId: string,
): Promise<{ removed: boolean; usersPolicy: "none" | "in-use" | "removed" | "gone" | null }> {
  const record = await readInstallAccess(deps.db, installId);
  if (record === null) return { removed: false, usersPolicy: null };
  // An application whose creation was never recorded (its answer was lost)
  // is found by its token policy, whose name carries the install id: its
  // policy names the token, which cannot be deleted before it.
  const appId =
    record.accessAppId ??
    (
      await asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
        deps.client.access.listApps(),
      )
    ).find((app) => (app.policies ?? []).some((p) => p.name === probesPolicyName(installId)))?.id ??
    null;
  if (appId !== null) {
    try {
      await asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
        deps.client.access.deleteApp(appId),
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await recordInstallProtection(deps.db, installId, null, nowOf(deps));
  }
  await deleteInstallServiceToken(deps, installId);
  const users = await removeAppAccessUsersPolicyIfUnused(deps);
  return { removed: true, usersPolicy: users.reason };
}

// ---------------------------------------------------------------- users policy

/** Emails of every user who is not banned, members included: lower-cased, sorted, unique. */
export async function listUserEmails(d1: D1Database): Promise<string[]> {
  const rows = await createDb(d1).select({ email: user.email, banned: user.banned }).from(user);
  const emails = rows
    .filter((row) => row.banned !== true)
    .map((row) => row.email.trim().toLowerCase())
    .filter((email) => email.length > 0);
  return [...new Set(emails)].sort();
}

/** The users to allow; never empty, since an empty include list is refused and would lock everyone out. */
async function allowList(d1: D1Database): Promise<string[]> {
  const emails = await listUserEmails(d1);
  if (emails.length === 0) throw new AccessToggleError(INSTALL_ACCESS_MESSAGES.noUsers);
  return emails;
}

async function storedUsersPolicyId(d1: D1Database): Promise<string | null> {
  const s = await readSettings(createDb(d1), [SETTING.appAccessUsersPolicyId]);
  return s.app_access_users_policy_id || null;
}

export type UsersPolicyOutcome = "updated" | "created" | "adopted" | "recreated";

/**
 * Makes sure "Appflare users" exists and lists exactly the current users, and
 * returns its id. A stored policy is rewritten; one gone from Cloudflare, or
 * never stored, is first looked for by name (an earlier write was lost) and
 * adopted, else created. Caller holds `withAccessLock`.
 */
export async function ensureAppAccessUsersPolicy(
  deps: Pick<InstallAccessDeps, "db" | "client" | "now">,
): Promise<{ policyId: string; outcome: UsersPolicyOutcome; userEmails: string[] }> {
  const { access } = deps.client;
  const userEmails = await allowList(deps.db);
  const policy = usersPolicy(userEmails);
  const stored = await storedUsersPolicyId(deps.db);
  const put = (id: string) =>
    asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
      access.updateReusablePolicy(id, policy),
    );
  const orm = createDb(deps.db);
  const done = async (policyId: string, outcome: UsersPolicyOutcome) => {
    await writeSettings(orm, { [SETTING.appAccessUsersPolicyId]: policyId }, nowOf(deps));
    await deleteSettings(orm, [SETTING.appAccessUsersSyncFailedAt]);
    return { policyId, outcome, userEmails };
  };
  if (stored !== null) {
    try {
      await put(stored);
      return await done(stored, "updated");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  const existing = (
    await asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
      access.listReusablePolicies(),
    )
  ).find((p) => p.name === USERS_POLICY_NAME);
  if (existing !== undefined) {
    await put(existing.id);
    return done(existing.id, stored === null ? "adopted" : "recreated");
  }
  const created = await asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
    access.createReusablePolicy(policy),
  );
  return done(created.id, stored === null ? "created" : "recreated");
}

export type SyncAppAccessUsersResult =
  | { ok: true; on: false }
  | { ok: true; on: true; userEmails: string[] };

/**
 * "Appflare users" was deleted in the Zero Trust dashboard. The cron makes it
 * again, but the protected apps referenced the deleted one, so each must be
 * protected again to let people in.
 */
export class UsersPolicyMissingError extends AccessToggleError {
  override name = "UsersPolicyMissingError";
  constructor() {
    super(INSTALL_ACCESS_MESSAGES.usersPolicyMissing);
  }
}

/**
 * After a user change: rewrites "Appflare users" to list exactly the current
 * users, under the Access lock. A no-op, with no Cloudflare call, while the
 * policy does not exist. A failure is remembered
 * (`app_access_users_sync_failed_at`, so the cron tries again) and thrown,
 * `UsersPolicyMissingError` when the policy is gone; a success clears it.
 * Never writes an empty list.
 */
export async function syncAppAccessUsers(deps: {
  db: D1Database;
  client: () => Promise<CloudflareClient>;
  now?: () => Date;
}): Promise<SyncAppAccessUsersResult> {
  if ((await storedUsersPolicyId(deps.db)) === null) return { ok: true, on: false };
  const orm = createDb(deps.db);
  try {
    return await withAccessLock(deps.db, async (): Promise<SyncAppAccessUsersResult> => {
      // Read again under the lock: the policy may have been removed meanwhile.
      const policyId = await storedUsersPolicyId(deps.db);
      if (policyId === null) return { ok: true, on: false };
      const userEmails = await allowList(deps.db);
      const client = await deps.client();
      try {
        await asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
          client.access.updateReusablePolicy(policyId, usersPolicy(userEmails)),
        );
      } catch (error) {
        if (isNotFound(error)) throw new UsersPolicyMissingError();
        throw error;
      }
      await deleteSettings(orm, [SETTING.appAccessUsersSyncFailedAt]);
      return { ok: true, on: true, userEmails };
    });
  } catch (error) {
    await writeSettings(
      orm,
      { [SETTING.appAccessUsersSyncFailedAt]: nowOf(deps).toISOString() },
      nowOf(deps),
    );
    throw error;
  }
}

/**
 * The cron: only when the last sync after a user change failed, brings
 * "Appflare users" back in step under the Access lock with
 * `ensureAppAccessUsersPolicy`, which also makes the policy again when it
 * was deleted (`recreated`: its id changed, and the protected apps still
 * name the old one until they are protected again). Nothing when the policy
 * was removed meanwhile because no app uses it.
 */
export async function resyncAppAccessUsersIfFailed(deps: {
  db: D1Database;
  client: () => Promise<CloudflareClient>;
  now?: () => Date;
}): Promise<"not-needed" | "resynced" | "recreated"> {
  const orm = createDb(deps.db);
  const s = await readSettings(orm, [SETTING.appAccessUsersSyncFailedAt]);
  if (!s.app_access_users_sync_failed_at) return "not-needed";
  const client = await deps.client();
  return withAccessLock(deps.db, async () => {
    const before = await storedUsersPolicyId(deps.db);
    if (before === null) {
      await deleteSettings(orm, [SETTING.appAccessUsersSyncFailedAt]);
      return "not-needed";
    }
    const ready = await ensureAppAccessUsersPolicy({ db: deps.db, client, now: deps.now });
    return ready.policyId === before ? "resynced" : "recreated";
  });
}

/**
 * Deletes "Appflare users" once nothing uses it: no install is protected by
 * Appflare and Cloudflare counts no application referencing it (one added in
 * the dashboard keeps it). For the unprotect path, after the last protected
 * app's application is gone. Caller holds `withAccessLock`.
 */
export async function removeAppAccessUsersPolicyIfUnused(
  deps: Pick<InstallAccessDeps, "db" | "client">,
): Promise<{ removed: boolean; reason: "none" | "in-use" | "removed" | "gone" }> {
  const policyId = await storedUsersPolicyId(deps.db);
  if (policyId === null) return { removed: false, reason: "none" };
  if (await anyProtectedInstall(deps.db)) return { removed: false, reason: "in-use" };
  const orm = createDb(deps.db);
  const forget = () =>
    deleteSettings(orm, [SETTING.appAccessUsersPolicyId, SETTING.appAccessUsersSyncFailedAt]);
  const listed = (
    await asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
      deps.client.access.listReusablePolicies(),
    )
  ).find((p) => p.id === policyId);
  if (listed === undefined) {
    await forget();
    return { removed: true, reason: "gone" };
  }
  // An unknown count is treated as in use: deleting a policy an app relies on is not undoable.
  if ((listed.app_count ?? 1) > 0) return { removed: false, reason: "in-use" };
  try {
    await asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
      deps.client.access.deleteReusablePolicy(policyId),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await forget();
  return { removed: true, reason: "removed" };
}

// ---------------------------------------------------------------- cron renewal

/** Whether `expiresAt` is within the refresh margin of `now` (or past). Unknown never is. */
export function serviceTokenNeedsRefresh(expiresAt: Date | null, now: Date): boolean {
  if (expiresAt === null || Number.isNaN(expiresAt.getTime())) return false;
  return expiresAt.getTime() - now.getTime() < SERVICE_TOKEN_REFRESH_BEFORE_MS;
}

export interface TokenRenewal {
  installId: string;
  status:
    | "refreshed"
    | "rotated"
    /** Nothing to do once re-read under the lock (another change got there first). */
    | "fresh"
    /** Gone from Cloudflare; protecting the app again makes a new one. */
    | "missing"
    | "failed";
  /** Why it failed; never contains a secret. */
  detail?: string;
}

/**
 * The cron's upkeep of every install's token. Reads D1 only unless a token
 * has less than 30 days left (`refreshServiceToken` renews its expiry; the id
 * and secret stay) or its secret no longer reads (it is rotated). Each
 * install is re-read under the Access lock before anything is changed, and
 * at most `RENEWALS_PER_RUN` are handled per run.
 */
export async function renewInstallServiceTokens(deps: {
  db: D1Database;
  client: () => Promise<CloudflareClient>;
  authSecret: string | undefined;
  now?: () => Date;
}): Promise<TokenRenewal[]> {
  const now = nowOf(deps);
  const canRotate = deps.authSecret !== undefined && deps.authSecret.length > 0;
  const needsWork = async (r: InstallAccessRecord) =>
    (canRotate && !(await readable(deps.authSecret, r))) ||
    serviceTokenNeedsRefresh(r.expiresAt, now);
  const due: InstallAccessRecord[] = [];
  for (const record of await listInstallAccess(deps.db)) {
    if (due.length >= RENEWALS_PER_RUN) break;
    if (await needsWork(record)) due.push(record);
  }
  if (due.length === 0) return [];
  const client = await deps.client();
  const out: TokenRenewal[] = [];
  for (const { installId } of due) {
    try {
      const status = await withAccessLock(deps.db, async (): Promise<TokenRenewal["status"]> => {
        const current = await readInstallAccess(deps.db, installId);
        if (current === null) return "fresh";
        if (canRotate && !(await readable(deps.authSecret, current))) {
          // A few minutes' grace for the previous secret, for any check
          // that read it just before the rotation.
          const previousSecretExpiresAt = new Date(now.getTime() + ROTATION_GRACE_MS).toISOString();
          await storeToken(
            deps,
            installId,
            await asAccessError(INSTALL_ACCESS_MESSAGES.tokensPermission, () =>
              client.access.rotateServiceToken(current.tokenId, { previousSecretExpiresAt }),
            ),
          );
          return "rotated";
        }
        if (!serviceTokenNeedsRefresh(current.expiresAt, now)) return "fresh";
        const refreshed = await asAccessError(INSTALL_ACCESS_MESSAGES.tokensPermission, () =>
          client.access.refreshServiceToken(current.tokenId),
        );
        const expiresAt = refreshed.expires_at ? new Date(refreshed.expires_at) : null;
        await createDb(deps.db)
          .update(install_access)
          .set({ token_expires_at: expiresAt, updated_at: now })
          .where(eq(install_access.install_id, installId));
        return "refreshed";
      });
      out.push({ installId, status });
    } catch (error) {
      if (isNotFound(error)) out.push({ installId, status: "missing" });
      else {
        out.push({
          installId,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- removing Appflare

/** Fields of an application's answer that are not settings and are never sent back. */
const READ_ONLY_APP_FIELDS = new Set([
  "id",
  "uid",
  "aud",
  "created_at",
  "updated_at",
  "policies",
  "self_hosted_domains",
]);

/**
 * Every setting `app` answered with (destinations, session duration,
 * cookies, ...), without the fields that are not settings: what a `PUT`
 * sends back to keep them, since it resets whatever it leaves out.
 */
export function accessAppSettings(app: AccessApp): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(app)) {
    if (READ_ONLY_APP_FIELDS.has(key)) continue;
    if (key === "domain" && (value === null || value === "")) continue;
    settings[key] = value;
  }
  return settings;
}

/** `app`'s policies as references (`{ id, precedence }`), which a `PUT` keeps as they are. */
export function policyReferences(
  policies: AccessApp["policies"],
): Array<{ id: string; precedence?: number }> {
  return (policies ?? []).map((p) =>
    p.precedence === undefined ? { id: p.id } : { id: p.id, precedence: p.precedence },
  );
}

/**
 * The body that puts `app` back as it is, minus the install's token policy:
 * every setting the application answered with and every other policy by
 * id, "Appflare users" included. A `PUT` resets what it leaves out, hence
 * the full body.
 */
export function appWithoutProbesPolicy(
  app: AccessApp,
  installId: string,
  probesPolicyId: string | null,
): CreateAccessAppArgs {
  const policies = policyReferences(
    (app.policies ?? []).filter(
      (p) => p.id !== probesPolicyId && p.name !== probesPolicyName(installId),
    ),
  );
  return { ...accessAppSettings(app), type: "self_hosted", policies } as CreateAccessAppArgs;
}

export interface RemovalRelease {
  released: string[];
  failed: Array<{ installId: string; message: string }>;
}

/**
 * For "Remove Appflare from this account": takes every install's token out
 * of Cloudflare, and leaves the apps protected. Per install, its Access
 * application is put back without its token policy (a full `PUT` of what it
 * answered, so destinations, session settings and the "Appflare users"
 * reference stay), then its token is deleted. The applications and "Appflare
 * users" stay, so every app keeps asking its users to sign in once the
 * manager is gone. One install failing does not stop the others. With
 * `installIds`, only those installs (the removal releases a few per call,
 * each call in an invocation of its own).
 */
export async function releaseAppAccessForRemoval(
  deps: Pick<InstallAccessDeps, "db" | "client" | "now">,
  installIds?: readonly string[],
): Promise<RemovalRelease> {
  return withAccessLock(deps.db, async () => {
    const out: RemovalRelease = { released: [], failed: [] };
    const records =
      installIds === undefined
        ? await listInstallAccess(deps.db)
        : installIds.length === 0
          ? []
          : (
              await createDb(deps.db)
                .select()
                .from(install_access)
                .where(inArray(install_access.install_id, [...installIds]))
                .orderBy(install_access.install_id)
            ).map(recordOf);
    for (const record of records) {
      try {
        const appId = record.accessAppId;
        if (appId !== null) {
          let app: AccessApp | null = null;
          try {
            app = await asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
              deps.client.access.getApp(appId),
            );
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
          if (app !== null) {
            const body = appWithoutProbesPolicy(app, record.installId, record.probesPolicyId);
            await asAccessError(INSTALL_ACCESS_MESSAGES.policiesPermission, () =>
              deps.client.access.updateApp(appId, body),
            );
          }
        }
        await deleteInstallServiceToken(deps, record.installId);
        out.released.push(record.installId);
      } catch (error) {
        out.failed.push({
          installId: record.installId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  });
}
