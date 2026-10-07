import { settingsLink } from "../components/settings-links";

/**
 * How a "Sign in with Cloudflare" reconnect ended, as the return route
 * (`POST /api/cloudflare/oauth-return`) reports it to the connection
 * settings: a fixed code in the address (`?cloudflare=<code>`), never a
 * message, an id or a token. Client-safe and server-safe.
 *
 * The code is only words to show: anyone can type an address with one, so
 * nothing trusts it. What the connection really is shows on the card itself.
 */

export const RECONNECT_OUTCOMES = [
  /** The new authorization is stored; Appflare connects with it. */
  "connected",
  /** Connected, but the API token Appflare used before could not be removed from its Worker. */
  "connected-token-kept",
  /** Stored, but an API token saved at the same time took its place: the card shows which. */
  "changed-meanwhile",
  /** The person said no on Cloudflare's page (`access_denied`). */
  "declined",
  /** Cloudflare ended the sign-in with another OAuth error. */
  "cloudflare-error",
  /** The authorization is for another account than the one Appflare manages. */
  "wrong-account",
  /** Cloudflare granted fewer permissions than Appflare needs. */
  "missing-permissions",
  /** No sign-in started here matches: too old (10 minutes), already used, or never started. */
  "expired",
  /** The person who started it is no longer an administrator. */
  "not-allowed",
  /** Cloudflare did not answer. */
  "unreachable",
  /** Another change to the connection was in progress. */
  "busy",
  /** Too many returns from this network in a short time. */
  "too-many",
  /** Anything else; the manager's log has the details. */
  "failed",
] as const;

export type ReconnectOutcome = (typeof RECONNECT_OUTCOMES)[number];

/** The search parameter the outcome travels in. */
export const RECONNECT_OUTCOME_PARAM = "cloudflare";

export function parseReconnectOutcome(value: unknown): ReconnectOutcome | null {
  return typeof value === "string" && (RECONNECT_OUTCOMES as readonly string[]).includes(value)
    ? (value as ReconnectOutcome)
    : null;
}

/** Where the return route sends the browser: the connection settings, with the outcome. */
export function reconnectOutcomeHref(outcome: ReconnectOutcome): string {
  const [path, hash] = settingsLink("account", "connection").split("#");
  return `${path}?${RECONNECT_OUTCOME_PARAM}=${outcome}#${hash}`;
}

/** The connection settings with Reconnect Cloudflare already open (`?reconnect=1`). */
export function reconnectDialogHref(): string {
  const [path, hash] = settingsLink("account", "connection").split("#");
  return `${path}?reconnect=1#${hash}`;
}

export interface ReconnectOutcomeCopy {
  /** `success` when Appflare is connected; `notice` when it is, but not as asked; `error` for the rest. */
  variant: "success" | "notice" | "error";
  title: string;
  description: string;
  /** Whether offering to start again makes sense. */
  retry: boolean;
}

/** The end of every outcome that changed nothing and can be started again. */
const NOTHING_CHANGED = "Nothing changed.";

/** One short line each: what happened and, when it helps, what to do. */
export const RECONNECT_OUTCOME_COPY: Record<ReconnectOutcome, ReconnectOutcomeCopy> = {
  connected: {
    variant: "success",
    title: "Connected with Cloudflare sign-in",
    description: "Appflare can manage your account again. It may take a few seconds to redeploy.",
    retry: false,
  },
  "connected-token-kept": {
    variant: "success",
    title: "Connected with Cloudflare sign-in",
    description:
      "Appflare could not remove its old API token from its Worker. It no longer uses it; delete it in Cloudflare.",
    retry: false,
  },
  "changed-meanwhile": {
    variant: "notice",
    title: "An API token was saved meanwhile",
    description: "Appflare uses that token. Start again to sign in with Cloudflare instead.",
    retry: true,
  },
  declined: {
    variant: "error",
    title: "Cloudflare sign-in was cancelled",
    description: `Access was not approved. ${NOTHING_CHANGED}`,
    retry: true,
  },
  "cloudflare-error": {
    variant: "error",
    title: "Cloudflare did not finish the sign-in",
    description: NOTHING_CHANGED,
    retry: true,
  },
  "wrong-account": {
    variant: "error",
    title: "That is a different Cloudflare account",
    description: `Start again and choose the account Appflare is installed in. ${NOTHING_CHANGED}`,
    retry: true,
  },
  "missing-permissions": {
    variant: "error",
    title: "Some permissions were not granted",
    description: `Start again and allow every permission Appflare asks for. ${NOTHING_CHANGED}`,
    retry: true,
  },
  expired: {
    variant: "error",
    title: "This sign-in has expired",
    description: `A sign-in works once, within 10 minutes. ${NOTHING_CHANGED}`,
    retry: true,
  },
  "not-allowed": {
    variant: "error",
    title: "Only an administrator can reconnect Cloudflare",
    description: `Whoever started this sign-in is no longer an administrator. ${NOTHING_CHANGED}`,
    retry: false,
  },
  unreachable: {
    variant: "error",
    title: "Appflare could not reach Cloudflare",
    description: NOTHING_CHANGED,
    retry: true,
  },
  busy: {
    variant: "error",
    title: "Another change was in progress",
    description: `Wait a minute, then start again. ${NOTHING_CHANGED}`,
    retry: true,
  },
  "too-many": {
    variant: "error",
    title: "Too many attempts",
    description: "Wait ten minutes, then try again.",
    retry: false,
  },
  failed: {
    variant: "error",
    title: "Reconnecting did not work",
    description: NOTHING_CHANGED,
    retry: true,
  },
};
