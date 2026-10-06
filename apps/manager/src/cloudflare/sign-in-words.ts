import { ACCESS_MESSAGES, INSTALL_ACCESS_MESSAGES } from "../access/messages";
import { NO_CONTAINERS_PERMISSION_REASON, NO_R2_PERMISSION_REASON } from "../sandbox/preflight";
import { RECONNECT_PLACE } from "./connection-errors";
import type { ConnectionKind } from "./connection-view";

/**
 * Cloudflare's refusals of a permission, in the words for how Appflare
 * connects. The messages written for an API token tell the admin to edit
 * the token; a manager connected with Cloudflare sign-in has no token to
 * edit, and asked for every permission when it connected, so its way out
 * is to reconnect and allow them all. Each token message Appflare refuses
 * with as is has its sign-in counterpart here. Client-safe.
 */

/** What a sign-in Cloudflare refused a permission tells the admin to do. */
export const SIGN_IN_PERMISSION_FIX = `Reconnect Cloudflare in ${RECONNECT_PLACE} and allow every permission Appflare asks for, then try again.`;

function refusedWith(what: string): string {
  return `Cloudflare did not let Appflare ${what} with its Cloudflare sign-in. ${SIGN_IN_PERMISSION_FIX}`;
}

/** Token message -> the same refusal for a Cloudflare sign-in. */
export const SIGN_IN_WORDS: ReadonlyMap<string, string> = new Map([
  [ACCESS_MESSAGES.appsPermission, refusedWith("manage Access applications")],
  [
    ACCESS_MESSAGES.organizationPermission,
    refusedWith("read the account's Zero Trust organization"),
  ],
  [
    INSTALL_ACCESS_MESSAGES.policiesPermission,
    refusedWith("manage Access applications and policies"),
  ],
  [INSTALL_ACCESS_MESSAGES.tokensPermission, refusedWith("manage Access service tokens")],
  [
    NO_CONTAINERS_PERMISSION_REASON,
    `Cloudflare did not let Appflare use Containers with its Cloudflare sign-in, and sandbox builds run in them. ${SIGN_IN_PERMISSION_FIX}`,
  ],
  [
    NO_R2_PERMISSION_REASON,
    `Cloudflare did not let Appflare use R2 with its Cloudflare sign-in, and sandbox builds keep their outputs there. ${SIGN_IN_PERMISSION_FIX}`,
  ],
]);

/** Whether `message` holds a token message that reads differently for a sign-in. */
export function hasTokenWords(message: string): boolean {
  for (const token of SIGN_IN_WORDS.keys()) if (message.includes(token)) return true;
  return false;
}

/**
 * `message` in the words for `kind`: for a sign-in, each token message in
 * it (on its own, or joined with others, or after a step's name) becomes
 * its sign-in counterpart. Unchanged for an API token.
 */
export function inConnectionWords(kind: ConnectionKind, message: string): string {
  if (kind !== "oauth") return message;
  let out = message;
  for (const [token, signIn] of SIGN_IN_WORDS) out = out.split(token).join(signIn);
  return out;
}
