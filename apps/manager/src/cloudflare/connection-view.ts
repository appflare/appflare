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

/**
 * Home's row and the settings card's notice while the connection needs
 * reconnecting: one line each. Why it happened is under the card's Details.
 */
export const RECONNECT_COPY = {
  title: "Reconnect Appflare to Cloudflare",
  /** Home's row, for everyone. */
  description: "Your apps keep running, but none can be installed or changed until then.",
  /** The card, for an administrator. */
  adminLine: "Your apps keep running. Reconnect to install or change them again.",
  /** The card, for a member. */
  memberLine: "Your apps keep running. An administrator reconnects here.",
  /** The action that reconnects, on the connection card and Home. */
  action: "Reconnect Cloudflare",
  /** The same choice while the connection works. */
  change: "Change how Appflare connects",
} as const;

/** The connection card's and its dialog's words, one short line each. */
export const CONNECTION_COPY = {
  cardDescription: "How Appflare reaches your Cloudflare account.",
  /** The value beside "Connected with": what the connection is called, never "OAuth". */
  kindName: { api_token: "An API token", oauth: "Cloudflare sign-in" } satisfies Record<
    ConnectionKind,
    string
  >,
  dialogDescription: "Your apps keep running either way.",
  /** The two ways, as the dialog offers them to a manager connected with `kind`. */
  ways: (kind: ConnectionKind) => ({
    signIn: "Recommended. Nothing to copy or paste.",
    tokenLabel: kind === "api_token" ? "Use a new API token" : "Use an API token",
    token:
      kind === "oauth"
        ? "Create one in Cloudflare and paste it here. It replaces the sign-in."
        : "Create one in Cloudflare and paste it here. It replaces the current token.",
  }),
  /** What happens after Continue to Cloudflare, for a browser at `host`. */
  signInNext: (host: string | null, kind: ConnectionKind) =>
    `Approve on Cloudflare, then confirm ${host ?? "this address"} on appflare.dev to come back.${
      kind === "api_token" ? " Appflare then removes its API token from its Worker." : ""
    }`,
  /** After an API token was saved in the dialog. */
  tokenSaved: (saved: { workerName: string; replacedAuthorization: boolean }) =>
    saved.replacedAuthorization
      ? `Appflare withdrew its Cloudflare sign-in and redeploys "${saved.workerName}" to use the token.`
      : `Appflare redeploys "${saved.workerName}" to use it. Revoke the old token in Cloudflare.`,
} as const;
