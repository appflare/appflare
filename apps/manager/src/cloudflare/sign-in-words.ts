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

/** A job's way on after a sign-in refused it: reconnect, then run the job again. */
function signInFixThen(next: string): string {
  return `Reconnect Cloudflare in ${RECONNECT_PLACE} and allow every permission Appflare asks for, then ${next}`;
}

/**
 * Token messages that carry names (a hostname, a zone, Cloudflare's own
 * words), matched by their fixed parts, with their sign-in counterpart. The
 * sign-in asked for every permission, so it names none; it says what was
 * refused and how to reconnect. Each pattern is checked against the message
 * its module builds (sign-in-words.test.ts), so a reworded token message
 * that no longer matches fails a test instead of reaching a sign-in as is.
 */
const SIGN_IN_REWRITES: ReadonlyArray<{
  token: RegExp;
  signIn: (...parts: string[]) => string;
}> = [
  // Attaching a custom domain (installs/custom-domains.server.ts).
  {
    token:
      /Cloudflare refused to attach (\S+): the token needs .+? on (\S+) \(and .+? to replace records\)\. Add them to the token and try again\./g,
    signIn: (hostname) => refusedWith(`attach ${hostname}`),
  },
  // Reading a zone for a custom domain, Email Routing or the gateway.
  {
    token: /The Cloudflare token cannot see that zone\. It needs .+? on it\./g,
    signIn: () => refusedWith("see that domain"),
  },
  {
    token: /The Cloudflare token cannot see that domain\. It needs .+? on it\./g,
    signIn: () => refusedWith("see that domain"),
  },
  {
    token: /The Cloudflare token cannot see that zone\./g,
    signIn: () => refusedWith("see that domain"),
  },
  // The domain an app receives email for, out of sight (jobs/reconfigure/email-again.ts,
  // jobs/update/email-routing.ts).
  {
    token:
      /Appflare cannot see (\S+), the domain the app receives email for: it may have been removed from Cloudflare, or the token lacks [^.]+\./g,
    signIn: (zone) =>
      `Appflare cannot see ${zone}, the domain the app receives email for: it may have been removed from Cloudflare, or Appflare's Cloudflare sign-in cannot see it. Reconnect Cloudflare in ${RECONNECT_PLACE} and allow every permission Appflare asks for.`,
  },
  // What setting up an app's email lacks (jobs/install/email-routing.ts and the two above).
  {
    token:
      /[Tt]he Cloudflare token lacks [^;]+?, which (.+?) needs; add them to the token \(for this zone\)/g,
    signIn: (what) =>
      `Cloudflare did not let Appflare's Cloudflare sign-in do what ${what} needs. Reconnect Cloudflare in ${RECONNECT_PLACE} and allow every permission Appflare asks for`,
  },
  // Email Routing's destination addresses (installs/email-routing.server.ts).
  {
    token:
      /The token cannot list the account's destination addresses \(it needs .+?\), so this page cannot show which ones are verified\./g,
    signIn: () =>
      `Cloudflare did not let Appflare list the account's destination addresses with its Cloudflare sign-in, so this page cannot show which ones are verified. ${SIGN_IN_PERMISSION_FIX}`,
  },
  // A refused Email Routing call (`permissionMessage`).
  {
    token:
      /Cloudflare refused to (.+?) \((.*?)\)\. The token needs .+? on the zone; add it to the token and try again/g,
    signIn: (what, said) =>
      `Cloudflare did not let Appflare ${what} with its Cloudflare sign-in (${said}). ${signInFixThen("try again")}`,
  },
  // A refused call on the external domains gateway's zone (gateway/gateway.server.ts).
  {
    token:
      /Cloudflare refused a call on (\S+): the token needs .+? on it\. Edit the token in the Cloudflare dashboard to add it, then try again\./g,
    signIn: (zone) => refusedWith(`make a call on ${zone}`),
  },
  // Uninstall steps (jobs/uninstall.ts).
  {
    token:
      /Cloudflare refused to remove the (external domain|custom domain|wildcard domain) (\S+) \((.*?)\)\. The token needs .+? on (?:the gateway domain|its zone); add (?:it|them) to the token and retry the uninstall/g,
    signIn: (kind, hostname, said) =>
      `Cloudflare did not let Appflare remove the ${kind} ${hostname} with its Cloudflare sign-in (${said}). ${signInFixThen("retry the uninstall")}`,
  },
  // Hyperdrive, for apps with a database elsewhere (jobs/install/phases.ts).
  {
    token:
      /Cloudflare refused the Hyperdrive call \((.*?)\)\. The API token needs .+?, an optional permission for apps with a database elsewhere: add it to the token in the Cloudflare dashboard, then try again/g,
    signIn: (said) =>
      `Cloudflare refused the Hyperdrive call with Appflare's Cloudflare sign-in (${said}). ${signInFixThen("try again")}`,
  },
  // Checking whether Access can protect apps (access/messages.ts `unchecked`).
  {
    token: /whether this account and its Cloudflare token can protect apps/g,
    signIn: () => "whether this account and Appflare's Cloudflare sign-in can protect apps",
  },
];

/** Whether `message` holds a token message that reads differently for a sign-in. */
export function hasTokenWords(message: string): boolean {
  for (const token of SIGN_IN_WORDS.keys()) if (message.includes(token)) return true;
  return SIGN_IN_REWRITES.some(({ token }) => new RegExp(token.source).test(message));
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
  for (const { token, signIn } of SIGN_IN_REWRITES) {
    out = out.replace(token, (_match, ...groups: unknown[]) =>
      signIn(...groups.filter((g): g is string => typeof g === "string")),
    );
  }
  return out;
}
