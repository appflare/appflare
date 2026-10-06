import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { readAccessConfig } from "../access/config";
import { accessGate } from "../access/gate";
import {
  type AccessCheck,
  type AccessToggleDeps,
  AccessToggleError,
  checkAccessPrerequisites,
  type DisableAccessResult,
  disableAccess,
  type EnableAccessResult,
  enableAccess,
  listAdminEmails,
  type SyncAccessResult,
  syncAccessAdmins,
} from "../access/toggle.server";
import { hasRole } from "../auth/roles";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { requireRole, requireSession } from "./auth.server";

export type { AccessCheck } from "../access/toggle.server";

/**
 * Settings → Cloudflare Access. Reading the state is open to every signed-in
 * user; checking, turning on or off, and re-syncing the policy are admin only.
 * Every call goes through the manager's own Cloudflare connection; errors carry
 * fixed messages or `CloudflareApiError` text (method, path, status), never
 * the token.
 */

export interface AccessStatus {
  enabled: boolean;
  /** The protected hostname, when on. */
  domain: string | null;
  /** `<team>.cloudflareaccess.com`, when on. */
  teamDomain: string | null;
  /** ISO 8601, when on. */
  enabledAt: string | null;
  /** The emails the allow policy should list (admins only; null for members). */
  adminEmails: string[] | null;
  /** The hostname this page was loaded on. */
  currentHostname: string;
}

async function deps(actorEmail: string): Promise<AccessToggleDeps> {
  return {
    db: env.DB,
    client: await getCfClient(env),
    hostname: new URL(getRequest().url).hostname,
    actorEmail,
  };
}

/** Re-throws expected failures as plain errors with a user-facing message. */
async function userFacing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof AccessToggleError ||
      error instanceof CloudflareApiError ||
      error instanceof CfTokenNotConfiguredError
    ) {
      throw new Error(error.message);
    }
    throw error;
  }
}

export const getAccessStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<AccessStatus> => {
    const session = await requireSession();
    const config = await readAccessConfig(env.DB);
    const isAdmin = hasRole(session.user.role, "admin");
    return {
      enabled: config !== null,
      domain: config?.domain || null,
      teamDomain: config?.teamDomain || null,
      enabledAt: config?.enabledAt || null,
      adminEmails: isAdmin ? await listAdminEmails(env.DB) : null,
      currentHostname: new URL(getRequest().url).hostname,
    };
  },
);

/** Admin only: runs every check that needs no change, for the confirmation dialog. */
export const checkAccess = createServerFn({ method: "POST" }).handler(
  async (): Promise<AccessCheck> => {
    const session = await requireRole("admin");
    return userFacing(async () => checkAccessPrerequisites(await deps(session.user.email)));
  },
);

/** Admin only: creates the Access applications and starts checking every request. */
export const turnOnAccess = createServerFn({ method: "POST" }).handler(
  async (): Promise<EnableAccessResult> => {
    const session = await requireRole("admin");
    const result = await userFacing(async () => enableAccess(await deps(session.user.email)));
    accessGate.invalidate();
    return result;
  },
);

/** Admin only: deletes the Access applications and stops checking requests. */
export const turnOffAccess = createServerFn({ method: "POST" }).handler(
  async (): Promise<DisableAccessResult> => {
    await requireRole("admin");
    const result = await userFacing(async () =>
      disableAccess({ db: env.DB, client: await getCfClient(env) }),
    );
    accessGate.invalidate();
    return result;
  },
);

/** Admin only: rewrites the allow policy to list exactly the current admins. */
export const resyncAccessAdmins = createServerFn({ method: "POST" }).handler(
  async (): Promise<SyncAccessResult> => {
    const session = await requireRole("admin");
    return userFacing(async () =>
      syncAccessAdmins({
        db: env.DB,
        client: await getCfClient(env),
        actorEmail: session.user.email,
      }),
    );
  },
);
