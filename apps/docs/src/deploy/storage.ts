import { z } from "zod";
import type { KeyValueStore } from "../install/memory.ts";

/**
 * Where the deploy page keeps things, and nothing else:
 *
 * - sessionStorage (this tab only, gone when it closes): the sign-in in
 *   progress (PKCE verifier and nonce) and the Cloudflare grant (access and
 *   refresh token). The callback page reads them after Cloudflare sends the
 *   tab back, and a reload during a deploy does not lose them.
 * - localStorage: the unfinished installation, `{ installationId, key,
 *   handoffSecret, accountId }`, so a later visit can continue or remove it.
 *   Never a token.
 *
 * Each slot is typed to its store, so a token cannot be written to
 * localStorage by mistake. Everything read back is checked again; a value
 * that does not parse is dropped. A browser that refuses storage gets slots
 * that keep nothing.
 */

export const AUTHORIZATION_KEY = "appflare.deploy.authorization";
export const GRANT_KEY = "appflare.deploy.grant";
export const INSTALLATION_KEY = "appflare.deploy.installation";

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** A sign-in started in this tab: what the callback needs to finish it. */
export const pendingAuthorizationSchema = z.strictObject({
  nonce: base64url.min(22).max(128),
  verifier: z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/),
  clientId: z.string().min(1).max(200),
  redirectUri: z.url(),
  startedAt: z.number().int().nonnegative(),
});
export type PendingAuthorization = z.infer<typeof pendingAuthorizationSchema>;

/** The Cloudflare connection this tab holds until it hands it to the new Appflare. */
export const grantSchema = z.strictObject({
  clientId: z.string().min(1).max(200),
  accessToken: z.string().min(1).max(8192),
  /** Epoch milliseconds. */
  expiresAt: z.number().int().nonnegative(),
  refreshToken: z.string().min(1).max(8192),
  scopes: z.array(z.string().min(1).max(200)).max(200),
});
export type Grant = z.infer<typeof grantSchema>;

/** An unfinished installation, as this browser remembers it between visits. */
export const localInstallationSchema = z.strictObject({
  installationId: z.string().regex(/^[0-9a-f-]{36}$/),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  handoffSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
});
export type LocalInstallation = z.infer<typeof localInstallationSchema>;

export interface Slot<T> {
  read(): T | null;
  /** False when the browser did not keep it. */
  write(value: T): boolean;
  clear(): void;
}

function attempt<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

function slot<T>(store: () => KeyValueStore | null, key: string, schema: z.ZodType<T>): Slot<T> {
  return {
    read() {
      const kv = attempt(store, null);
      if (kv === null) return null;
      const raw = attempt(() => kv.getItem(key), null);
      if (raw === null) return null;
      const parsed = schema.safeParse(attempt<unknown>(() => JSON.parse(raw), null));
      if (parsed.success) return parsed.data;
      attempt(() => kv.removeItem(key), undefined);
      return null;
    },
    write(value) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return false;
      const kv = attempt(store, null);
      if (kv === null) return false;
      return attempt(() => {
        kv.setItem(key, JSON.stringify(parsed.data));
        return true;
      }, false);
    },
    clear() {
      const kv = attempt(store, null);
      if (kv !== null) attempt(() => kv.removeItem(key), undefined);
    },
  };
}

export interface DeployStorage {
  /** sessionStorage */
  authorization: Slot<PendingAuthorization>;
  /** sessionStorage */
  grant: Slot<Grant>;
  /** localStorage */
  installation: Slot<LocalInstallation>;
}

/** The slots over a session store and a local store (tests pass plain objects). */
export function deployStorage(
  session: () => KeyValueStore | null,
  local: () => KeyValueStore | null,
): DeployStorage {
  return {
    authorization: slot(session, AUTHORIZATION_KEY, pendingAuthorizationSchema),
    grant: slot(session, GRANT_KEY, grantSchema),
    installation: slot(local, INSTALLATION_KEY, localInstallationSchema),
  };
}

/** This browser's storage. Reading `window.sessionStorage` itself throws where site data is blocked. */
export function browserDeployStorage(): DeployStorage {
  return deployStorage(
    () => (typeof window === "undefined" ? null : window.sessionStorage),
    () => (typeof window === "undefined" ? null : window.localStorage),
  );
}
