import { getRouteApi } from "@tanstack/react-router";

const appLayout = getRouteApi("/_app");

/**
 * The Cloudflare account Appflare runs in, for links into the dashboard; null
 * while the token step has not recorded it. Read from the signed-in layout's
 * context, so only components under it may call this.
 */
export function useAccountId(): string | null {
  return appLayout.useRouteContext({ select: (context) => context.accountId });
}
