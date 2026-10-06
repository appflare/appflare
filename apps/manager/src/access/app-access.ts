import type { AccessOffer } from "@appflare/schema";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { capabilityAnchor } from "../capabilities/capability-rows";
import { inConnectionWords } from "../cloudflare/sign-in-words";
import { settingsLink } from "../components/settings-links";
import { ACCESS_MESSAGES, INSTALL_ACCESS_MESSAGES } from "./messages";

/**
 * Protecting an installed app with Cloudflare Access, as the install form
 * and the app's page show it: what stands in the way and where it is fixed,
 * who gets in, how they sign in, and what stays public. Client-safe.
 *
 * Who gets in is every Appflare user who is not banned, members included,
 * through the one "Appflare users" policy all protected apps share; there is
 * no list per app.
 */

/** What stands in the way of protecting an app, by where it is fixed. */
export type AppAccessProblemKind =
  | "no-organization"
  | "team-domain"
  | "organization-permission"
  | "policies-permission"
  | "tokens-permission";

export interface AppAccessProblem {
  kind: AppAccessProblemKind;
  /** The words the protection itself refuses with. */
  message: string;
}

/** What `checkAppAccess` found: the live check, and who gets in and how. */
export interface AppAccessCheck {
  /** Null when the account and the token can protect apps, as far as reads show. */
  problem: AppAccessProblem | null;
  /** Appflare users who are not banned: everyone the "Appflare users" policy lets in. */
  users: number;
  /** The organization's login methods, as the dashboard names them; null when they could not be read. */
  loginMethods: string[] | null;
  /** One-time PIN is among them, so any email can sign in. */
  oneTimePin: boolean;
}

/** An installed app's protection, as its page shows it. */
export interface InstallAccessView {
  /** How the app's catalog entry offers protection. */
  offer: AccessOffer;
  /** Appflare protects the app: its Access application exists. */
  protected: boolean;
  /** The Access application's name, as Appflare made it; null while not protected. */
  appName: string | null;
  /** `<team>.cloudflareaccess.com`, where people sign in; null while not protected. */
  teamDomain: string | null;
  /**
   * Paths that stay public while the app is protected: those the entry lists
   * and an admin accepted, while it is protected; those the entry lists,
   * while it is not (protecting it accepts them).
   */
  publicPaths: string[];
  /**
   * Paths a catalog revision added to the entry since an admin last accepted
   * its public paths: listed, but asking for a sign-in until an admin makes
   * them public. Empty while the app is not protected.
   */
  pendingPublicPaths: string[];
  /** ISO 8601: when bringing the Access applications in step last failed; null when it did not. */
  syncFailedAt: string | null;
  /** The app's settings use the Access values, so a change of protection deploys it again. */
  usesAccessValues: boolean;
  /** Appflare users who are not banned. */
  users: number;
  /**
   * What Appflare's own records show to be wrong with the protection, which
   * protecting the app again repairs; null when nothing is. A protected
   * app's page offers "Protect again" only then.
   */
  repair: AccessRepair | null;
}

/** Why a protected app needs protecting again, as Appflare's records show it. */
export type AccessRepair =
  /** The cron found its Access application, or its public paths' one, gone from the account. */
  | "app-deleted"
  /** "Appflare users" was made again, and the app's application names the old one. */
  | "users-policy-replaced"
  /** No "Appflare users" policy is recorded, so nobody is let in. */
  | "users-policy-missing"
  /** The record of the app's application lacks its token policy, audience tag or team domain. */
  | "incomplete"
  /** Bringing its Access applications in step with its addresses last failed. */
  | "sync-failed";

/** One line on why "Protect again" is offered. */
export const ACCESS_REPAIR_REASONS: Record<AccessRepair, string> = {
  "app-deleted":
    "The Access application was deleted in Cloudflare, so the app's addresses no longer ask for a sign-in. Protect it again.",
  "users-policy-replaced":
    'The "Appflare users" policy was made again after it was deleted in the Zero Trust dashboard. This app still names the old one, so nobody can sign in until it is protected again.',
  "users-policy-missing":
    'Appflare has no "Appflare users" policy on record, so nobody can sign in to this app until it is protected again.',
  incomplete:
    "Appflare's record of this app's Access application is incomplete; protecting it again reads it back.",
  "sync-failed": "Protecting it again brings its Access applications in step now.",
};

/**
 * What to repair, from the records alone (no Cloudflare call): a deleted
 * application first, since it lets everyone in, then the users policy,
 * which keeps everyone out, then an incomplete record, then a failed sync.
 * Null for an app that is not protected.
 */
export function accessRepairOf(record: {
  protected: boolean;
  /** The cron found its Access application (or its public paths') gone. */
  appMissing?: boolean;
  syncFailed: boolean;
  probesPolicyId: string | null;
  aud: string | null;
  teamDomain: string | null;
  /** The users policy the app's application references, as last protected. */
  usersPolicyId: string | null;
  /** The users policy Appflare has on record now. */
  currentUsersPolicyId: string | null;
}): AccessRepair | null {
  if (!record.protected) return null;
  if (record.appMissing === true) return "app-deleted";
  if (record.currentUsersPolicyId === null) return "users-policy-missing";
  if (record.usersPolicyId !== record.currentUsersPolicyId) return "users-policy-replaced";
  if (record.probesPolicyId === null || !record.aud || !record.teamDomain) return "incomplete";
  if (record.syncFailed) return "sync-failed";
  return null;
}

/** What the stored capability probes already show to stand in the way; null when they show nothing. */
export function storedAccessProblem(
  view:
    | (Pick<CapabilitiesView, "zeroTrust" | "accessServiceTokens"> &
        Partial<Pick<CapabilitiesView, "connection">>)
    | null,
): AppAccessProblem | null {
  // A refused permission is fixed by editing the token, or reconnecting a sign-in.
  const words = (message: string) => inConnectionWords(view?.connection ?? "api_token", message);
  const zeroTrust = view?.zeroTrust ?? null;
  if (zeroTrust?.state === "none") {
    return { kind: "no-organization", message: ACCESS_MESSAGES.noOrganization };
  }
  if (zeroTrust?.state === "unknown" && zeroTrust.reason === "no-permission") {
    return {
      kind: "organization-permission",
      message: words(ACCESS_MESSAGES.organizationPermission),
    };
  }
  const tokens = view?.accessServiceTokens ?? null;
  if (tokens?.state === "unknown" && tokens.reason === "no-permission") {
    return { kind: "tokens-permission", message: words(INSTALL_ACCESS_MESSAGES.tokensPermission) };
  }
  return null;
}

/** Where a problem is fixed: its row of "What this account can run" on Your account. */
export function accessProblemFix(kind: AppAccessProblemKind): { href: string; label: string } {
  if (kind === "no-organization" || kind === "team-domain") {
    return {
      href: settingsLink("account", capabilityAnchor("zero-trust")),
      label: "Zero Trust in Your account",
    };
  }
  return {
    href: settingsLink("account", capabilityAnchor("token-permissions")),
    label: "Token permissions in Your account",
  };
}

/** How many users Cloudflare Zero Trust's Free plan covers. */
export const ZERO_TRUST_FREE_USERS = 50;

/** The quiet line shown only while Appflare has more users than Zero Trust Free covers. */
export function zeroTrustUsersNote(users: number | null): string | null {
  if (users === null || users <= ZERO_TRUST_FREE_USERS) return null;
  return `Zero Trust Free covers up to ${ZERO_TRUST_FREE_USERS} users; Appflare has ${users}.`;
}

/** "Only Appflare's users get in: 3 people, members included." */
export function whoGetsIn(users: number | null): string {
  if (users === null) return "Only Appflare's users get in, members included.";
  return `Only Appflare's users get in: ${users === 1 ? "1 person" : `${users} people`}, members included.`;
}

/** How people sign in, and that each must be able to with the email of their Appflare account. */
export function signInNote(check: Pick<AppAccessCheck, "loginMethods" | "oneTimePin">): string {
  const own = "Each signs in to Cloudflare Access first, with the email of their Appflare account.";
  if (check.loginMethods === null) return own;
  if (check.loginMethods.length === 0) {
    return `${own} The Zero Trust organization has no login methods yet; add One-time PIN in the Zero Trust dashboard.`;
  }
  const methods = `Login methods: ${check.loginMethods.join("; ")}.`;
  return check.oneTimePin
    ? `${own} ${methods}`
    : `${own} ${methods} Someone who cannot sign in with one of these keeps out; add One-time PIN in the Zero Trust dashboard to let any email in.`;
}

/** What stays public on the app's addresses while it is protected. */
export function publicPathsLine(paths: readonly string[]): string {
  if (paths.length === 0) {
    return "Everything at the app's addresses asks for a sign-in, links you share with others included.";
  }
  return `Stays public: ${paths.join(", ")}`;
}

/** Why an app whose entry requires protection has no off switch, in one line. */
export function accessRequiredLine(appName: string): string {
  return `${appName}'s catalog entry requires it: the app relies on Cloudflare Access to keep people out.`;
}

/** "The catalog now lists /x/* as public.": revision-added paths waiting for an admin. */
export function pendingPublicPathsLine(paths: readonly string[]): string {
  return `The catalog now lists ${paths.join(", ")} as public.`;
}

/** The warning on an unprotected app whose catalog entry now requires protection. */
export const ACCESS_NOW_REQUIRED_TITLE =
  "The catalog now says this app must run behind Cloudflare Access";
