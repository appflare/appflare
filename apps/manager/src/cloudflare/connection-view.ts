/**
 * The manager's Cloudflare connection as Settings and Home show it.
 * Client-safe (types and words only); `readConnectionState` in
 * connection.server.ts fills it.
 */

/**
 * How the manager reaches Cloudflare: `api_token`, the `CF_API_TOKEN` secret
 * an admin pasted (every manager set up before OAuth existed); `oauth`, a
 * grant someone authorized in Cloudflare, stored in D1.
 */
export type ConnectionKind = "api_token" | "oauth";

export type ConnectionState = "connected" | "needs_reconnect";

export interface ConnectionView {
  kind: ConnectionKind;
  state: ConnectionState;
  /**
   * Why the connection needs reconnecting, or the last problem renewing its
   * access (it may have passed since), in plain words; null when none.
   */
  problem: string | null;
  /** ISO 8601 */
  problemAt: string | null;
  /** ISO 8601: when this credential was connected (a token's last save, a grant's storing). */
  connectedSince: string | null;
  /**
   * The running version can use the credential: it has `CF_API_TOKEN`, or
   * the key the grant is sealed with. False for a few seconds after a
   * credential was stored, until the version that has it serves.
   */
  ready: boolean;
  /** An OAuth connection's client and the permissions Cloudflare granted; null for an API token. */
  oauth: {
    clientId: string;
    scopes: string[];
    /** Permissions Appflare asks for that the grant lacks. */
    missingScopes: string[];
    /** ISO 8601: when access was last renewed. */
    renewedAt: string;
  } | null;
}

/** What the connection is called, for people who never saw the word OAuth. */
export const CONNECTION_KIND_LABELS: Record<ConnectionKind, string> = {
  api_token: "API token",
  oauth: "Cloudflare authorization",
};

/** Home's row and the settings card's notice while the connection needs reconnecting. */
export const RECONNECT_COPY = {
  title: "Appflare needs to be reconnected to Cloudflare",
  description:
    "Cloudflare no longer accepts Appflare's connection, so apps cannot be installed, updated or removed. Your apps keep running. An administrator reconnects Cloudflare on the Your account page.",
} as const;
