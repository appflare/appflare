/**
 * Links into the Cloudflare dashboard for the account this manager runs in.
 *
 * Every link uses the dashboard's `?to=` deep-link form (the form Cloudflare's
 * own docs use, cloudflare-docs `src/content/dash-routes/*.json`), which
 * survives a sign-in redirect. With the account id in place of `:account` the
 * dashboard opens that account directly instead of asking which one, or
 * guessing, when a person has several. `:account` stays only where the id is
 * not known yet, such as before the first token is saved. Client-safe.
 */

const DASHBOARD = "https://dash.cloudflare.com";
const ZERO_TRUST_DASHBOARD = "https://one.dash.cloudflare.com";

/** What the dashboard replaces with an account the person picks. */
const ANY_ACCOUNT = ":account";

function accountSegment(accountId: string | null | undefined): string {
  return accountId ? encodeURIComponent(accountId) : ANY_ACCOUNT;
}

function withoutLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * An account-scoped dashboard page: `https://dash.cloudflare.com/?to=/<account id>/<path>`.
 * A null, undefined or empty id leaves `:account`, so the dashboard asks.
 */
export function dashboardUrl(accountId: string | null | undefined, path: string): string {
  return `${DASHBOARD}/?to=/${accountSegment(accountId)}/${withoutLeadingSlash(path)}`;
}

/**
 * A zone-scoped dashboard page, the zone named by its domain:
 * `https://dash.cloudflare.com/?to=/<account id>/<zone name>/<path>`.
 */
export function zoneDashboardUrl(
  accountId: string | null | undefined,
  zoneName: string,
  path: string,
): string {
  return dashboardUrl(accountId, `${encodeURIComponent(zoneName)}/${withoutLeadingSlash(path)}`);
}

/** A page of the Zero Trust dashboard: `https://one.dash.cloudflare.com/?to=/<account id>/<path>`. */
export function zeroTrustDashboardUrl(accountId: string | null | undefined, path: string): string {
  return `${ZERO_TRUST_DASHBOARD}/?to=/${accountSegment(accountId)}/${withoutLeadingSlash(path)}`;
}
