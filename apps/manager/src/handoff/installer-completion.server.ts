import type { FetchLike } from "@appflare/cf-api";
import { openValue, sealValue } from "../cloudflare/grant-seal";
import { createDb } from "../db/client";
import { hasAnyUser } from "../server/users.server";
import { handoffHashOf, installerDetailsKey } from "./handoff-proof";

/**
 * Telling the hosted installer that installed this manager that it is done.
 * The installer keeps a record of each unfinished installation (what it
 * created, so an interrupted one can be resumed or cleaned up). Once the
 * owner exists the manager calls
 * `POST <installer>/api/install/installations/<id>/complete` with the
 * record's key, and the installer deletes the record. The call is made
 * after the owner is created (in the background, never holding owner
 * creation up) and again by the cron until the installer answers 2xx, or
 * 404 for a record already gone; then the details are forgotten. A 400,
 * 401 or 403 cannot change by asking again, so the details are forgotten
 * then too; no answer, a 5xx or a 429 is asked again.
 *
 * The key is stored sealed (AES-GCM, with a key derived from the handoff
 * hash in the Worker's own `APPFLARE_HANDOFF` secret), never logged, and
 * sent only to the installer's origin, which must be `APPFLARE_INSTALLER_ORIGIN`.
 */

/** `settings` row: JSON `{ origin, installationId, key }`, `key` sealed. */
export const INSTALLER_DETAILS_KEY = "handoff_installer";

const COMPLETE_TIMEOUT_MS = 10_000;
/** The hosted installer's formats: a UUID, and 32 random bytes in base64url. */
const INSTALLATION_ID = /^[0-9a-f-]{36}$/;
const INSTALLATION_KEY = /^[A-Za-z0-9_-]{43}$/;

export interface InstallerDetails {
  url: string;
  installationId: string;
  key: string;
}

interface StoredDetails {
  origin: string;
  installationId: string;
  /** Sealed. */
  key: string;
}

function sealContext(installationId: string): string {
  return `appflare-installer-key:${installationId}`;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The installer origin from `APPFLARE_INSTALLER_ORIGIN`: `https:` (or
 * `http:` on a loopback host, for local development); null when unset or
 * not an origin.
 */
export function installerOriginOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The details to keep, when the page sent ones this manager may call: the
 * URL on the installer's own origin, an installation id, a key.
 */
export function acceptedInstaller(
  details: InstallerDetails,
  installerOrigin: string | null,
): { origin: string; installationId: string; key: string } | null {
  if (installerOrigin === null) return null;
  let origin: string;
  try {
    origin = new URL(details.url).origin;
  } catch {
    return null;
  }
  if (
    origin !== installerOrigin ||
    !INSTALLATION_ID.test(details.installationId) ||
    !INSTALLATION_KEY.test(details.key)
  ) {
    return null;
  }
  return { origin, installationId: details.installationId, key: details.key };
}

/** The statement that keeps the details, the key sealed, replacing any kept before. */
export async function installerDetailsStatement(
  d1: D1Database,
  hash: string,
  details: { origin: string; installationId: string; key: string },
  now: Date,
): Promise<D1PreparedStatement> {
  const stored: StoredDetails = {
    origin: details.origin,
    installationId: details.installationId,
    key: await sealValue(
      await installerDetailsKey(hash),
      details.key,
      sealContext(details.installationId),
    ),
  };
  return d1
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(INSTALLER_DETAILS_KEY, JSON.stringify(stored), now.getTime());
}

function parseDetails(value: string): StoredDetails | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredDetails>;
    if (
      typeof parsed.origin !== "string" ||
      typeof parsed.installationId !== "string" ||
      typeof parsed.key !== "string" ||
      !INSTALLATION_ID.test(parsed.installationId)
    ) {
      return null;
    }
    return { origin: parsed.origin, installationId: parsed.installationId, key: parsed.key };
  } catch {
    return null;
  }
}

export type CompletionOutcome =
  /** Nothing to report: no details kept. */
  | "none"
  /** Kept until the owner exists. */
  | "waiting"
  /** The installer confirmed (2xx); the details are forgotten. */
  | "completed"
  /** The installer no longer has the record (404); the details are forgotten. */
  | "gone"
  /** No answer, a 5xx, a 429 or another status; kept for the next try. */
  | "failed"
  /** 400, 401 or 403: the installer will not accept it; forgotten. */
  | "refused"
  /** The details cannot be used (the key can no longer be opened); forgotten. */
  | "dropped";

export interface CompletionEnv {
  DB: D1Database;
  APPFLARE_HANDOFF?: string;
}

/**
 * Reports the end of setup to the installer, once the owner exists. Never
 * throws: every outcome is returned, and logged without the key.
 */
export async function completeInstallation(
  env: CompletionEnv,
  deps: { fetch?: FetchLike } = {},
): Promise<CompletionOutcome> {
  try {
    return await complete(env, deps);
  } catch (error) {
    console.error("installer: could not report the end of setup", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

async function complete(env: CompletionEnv, deps: { fetch?: FetchLike }) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(INSTALLER_DETAILS_KEY)
    .first<{ value: string }>();
  if (row === null) return "none";
  if (!(await hasAnyUser(createDb(env.DB)))) return "waiting";
  const forget = () =>
    env.DB.prepare("DELETE FROM settings WHERE key = ?1 AND value = ?2")
      .bind(INSTALLER_DETAILS_KEY, row.value)
      .run();

  const details = parseDetails(row.value);
  const hash = handoffHashOf(env.APPFLARE_HANDOFF);
  let key: string | null = null;
  if (details !== null && hash !== null) {
    key = await openValue(
      await installerDetailsKey(hash),
      details.key,
      sealContext(details.installationId),
    ).catch(() => null);
  }
  if (details === null || key === null) {
    await forget();
    console.warn(
      "installer: the details for reporting the end of setup cannot be read; forgotten. The installer keeps its record until it is removed there.",
    );
    return "dropped";
  }

  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const url = `${details.origin}/api/install/installations/${encodeURIComponent(details.installationId)}/complete`;
  let status: number;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "appflare-manager",
      },
      body: JSON.stringify({ key }),
      redirect: "manual",
      signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
    });
    status = response.status;
    await response.body?.cancel();
  } catch (error) {
    console.warn("installer: no answer to the end of setup; the cron tries again", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return "failed";
  }
  if ((status >= 200 && status < 300) || status === 404) {
    await forget();
    console.log(`installer: end of setup reported (${status})`);
    return status === 404 ? "gone" : "completed";
  }
  if (status === 400 || status === 401 || status === 403) {
    // An answer the same request cannot change: asking again would only repeat it.
    await forget();
    console.warn(
      `installer: end of setup refused (${status}); not asked again. The installer keeps its record until it is removed there.`,
    );
    return "refused";
  }
  console.warn(`installer: end of setup not confirmed (${status}); the cron tries again`);
  return "failed";
}
