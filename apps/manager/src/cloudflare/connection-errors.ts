import { settingsPlace } from "../components/settings-links";

/**
 * Why the manager cannot reach Cloudflare right now, in words for the people
 * who own the account (the message is shown as is: in a job's log and error,
 * in a refused action, on Home). No token, code or key ever appears in one.
 * Client-safe and server-safe.
 */

export type CloudflareConnectionProblem =
  /** No API token and no grant: setup has not connected Cloudflare. */
  | "not_configured"
  /** Cloudflare no longer accepts the grant (revoked, expired, or used elsewhere). */
  | "needs_reconnect"
  /** The running version cannot read the stored grant, and it is not a redeploy in progress. */
  | "key_lost"
  /** A grant was just stored and this version does not have its key yet. */
  | "redeploying"
  /** Renewing access failed in a way that may pass (no answer, 5xx, 429, a busy refresh). */
  | "temporary"
  /** Cloudflare refused to renew access for another reason than the grant itself. */
  | "refused";

/** Where an administrator reconnects Cloudflare, as a link inside a message. */
export const RECONNECT_PLACE = settingsPlace("account", "connection");

export const CONNECTION_MESSAGES = {
  /** The words jobs have used since before OAuth connections existed. */
  notConfigured: "the Cloudflare API token is not configured; finish setup first",
  needsReconnect: `Cloudflare no longer accepts Appflare's connection to your account, so Appflare cannot change anything there. An administrator must reconnect Cloudflare in ${RECONNECT_PLACE}. Your apps keep running.`,
  keyLost: `This version of Appflare cannot read its saved connection to Cloudflare. An administrator must reconnect Cloudflare in ${RECONNECT_PLACE}. Your apps keep running.`,
  redeploying:
    "Appflare is still redeploying itself with its new Cloudflare connection. Try again in a few seconds.",
  temporary:
    "Appflare could not renew its access to Cloudflare just now: Cloudflare did not answer or was busy. Try again in a minute.",
  busy: "Appflare is renewing its access to Cloudflare in another request. Try again in a minute.",
  refused: (code: string) =>
    `Cloudflare refused to renew Appflare's access (${code}). If it keeps happening, an administrator can reconnect Cloudflare in ${RECONNECT_PLACE}. Your apps keep running.`,
} as const;

/**
 * The connection cannot give a credential. `retryable` says whether trying
 * again later can help without anyone doing anything: jobs retry those steps
 * and end on the others with this message.
 */
export class CloudflareConnectionError extends Error {
  override name = "CloudflareConnectionError";
  readonly retryable: boolean;
  constructor(
    readonly problem: CloudflareConnectionProblem,
    message: string,
  ) {
    super(message);
    this.retryable = problem === "redeploying" || problem === "temporary";
  }
}

/** The problems only an administrator reconnecting Cloudflare solves. */
export function needsReconnecting(problem: CloudflareConnectionProblem): boolean {
  return problem === "needs_reconnect" || problem === "key_lost";
}
