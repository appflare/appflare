import { Buffer } from "node:buffer";
import type { CloudflareClient } from "@appflare/cf-api";
import { count } from "drizzle-orm";
import { createDb } from "../db/client";
import { notification_channels, session } from "../db/schema";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { releaseSettingsLock, tryAcquireSettingsLock } from "../db/settings-lock";
import { DangerError } from "./errors";

/**
 * Rotating the auth secret (Settings > General, owner only).
 *
 * `BETTER_AUTH_SECRET` signs every session cookie, and the key that encrypts
 * notification channel credentials is derived from it. A new random value is
 * written to the manager's own Worker through the secrets API, which deploys
 * a new version of the same code with it, as storing the Cloudflare token
 * does. The request that writes it finishes on the running version. Then
 * every session row is deleted, so everyone is signed out at once instead of
 * as the new version reaches each isolate, and the moment is recorded so
 * Settings can show it. Stored channel credentials were encrypted with a key
 * derived from the old value and can no longer be read; the notifications
 * page asks for them again.
 *
 * The value never leaves this function except in the one API call: it is
 * not logged, stored, or returned.
 */

export const AUTH_SECRET_NAME = "BETTER_AUTH_SECRET";

/** Serializes two rotations started at once. */
const ROTATION_LOCK_KEY = "auth_secret_lock";
const ROTATION_LOCK_TTL_MS = 60_000;

/** 32 random bytes, base64url: the same shape the installer gives the first value. */
export function generateAuthSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export interface RotateAuthSecretDeps {
  db: D1Database;
  api: CloudflareClient;
  now?: () => Date;
  /** Test seam for the new value. */
  generate?: () => string;
}

export interface RotateAuthSecretResult {
  /** ISO 8601. */
  rotatedAt: string;
  workerName: string;
  /** Notification channels whose credentials must now be entered again. */
  channels: number;
}

export const ROTATION_MESSAGES = {
  busy: "The auth secret is being rotated already. Wait a minute, then reload Settings.",
  noWorkerName:
    "Appflare does not know its own Worker name yet. Save the Cloudflare token under Settings first.",
} as const;

export async function rotateAuthSecretCore(
  deps: RotateAuthSecretDeps,
): Promise<RotateAuthSecretResult> {
  const lockOwner = crypto.randomUUID();
  if (
    !(await tryAcquireSettingsLock(deps.db, ROTATION_LOCK_KEY, lockOwner, ROTATION_LOCK_TTL_MS))
  ) {
    throw new DangerError(ROTATION_MESSAGES.busy, 409);
  }
  try {
    const orm = createDb(deps.db);
    const { worker_name: workerName } = await readSettings(orm, [SETTING.workerName]);
    if (!workerName) throw new DangerError(ROTATION_MESSAGES.noWorkerName, 409);

    await deps.api.workers.putSecret(workerName, {
      name: AUTH_SECRET_NAME,
      type: "secret_text",
      text: (deps.generate ?? generateAuthSecret)(),
    });
    const at = (deps.now ?? (() => new Date()))();
    await writeSettings(orm, { [SETTING.authSecretRotatedAt]: at.toISOString() }, at);
    await orm.delete(session);
    const [channels] = await orm.select({ n: count() }).from(notification_channels);
    return { rotatedAt: at.toISOString(), workerName, channels: channels?.n ?? 0 };
  } finally {
    await releaseSettingsLock(deps.db, ROTATION_LOCK_KEY, lockOwner);
  }
}

/** When the auth secret was last rotated from Settings (ISO 8601), or null. */
export async function readAuthSecretRotatedAt(db: D1Database): Promise<string | null> {
  const row = await readSettings(createDb(db), [SETTING.authSecretRotatedAt]);
  return row.auth_secret_rotated_at ?? null;
}
