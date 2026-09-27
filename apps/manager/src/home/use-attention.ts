import { getRouteApi, type HistoryState, useRouter } from "@tanstack/react-router";
import { type MouseEvent, useMemo } from "react";
import { isPlainClick } from "../components/router-anchor";
import {
  type AccountAttentionRow,
  type AttentionItem,
  accountRowKey,
  attentionItems,
  homeName,
} from "./attention";
import { useDismissedRows } from "./dismissed-rows";
import { HOME_CLICK_STATE } from "./home-landing";
import type { LayoutData } from "./layout-data";

const appLayout = getRouteApi("/_app");

export interface Attention {
  data: LayoutData;
  isAdmin: boolean;
  items: AttentionItem[];
  /** "Not needed" on an account row: put away in this browser while it needs action for the same apps. */
  dismissAccountRow(row: AccountAttentionRow): void;
}

/**
 * The signed-in layout's data and what needs attention in it, with this
 * browser's "Not needed" choices applied. The sidebar and Home both read it,
 * so the count, the dots and the list always agree. Only components under
 * the signed-in layout may call this.
 */
export function useAttention(
  /** Updates the last "Update all" left for the admin (Home only). */
  leftForAdmin?: ReadonlyMap<string, string>,
): Attention {
  const data = appLayout.useLoaderData();
  const isAdmin = appLayout.useRouteContext({ select: (c) => c.viewer.role === "admin" });
  // The rows needing action now; members get none, so their browser keeps what it stored.
  const current = useMemo(
    () =>
      isAdmin
        ? new Set(data.accountRows.filter((r) => r.dismissible).map((r) => accountRowKey(r)))
        : null,
    [isAdmin, data.accountRows],
  );
  const [dismissed, dismiss] = useDismissedRows(current);
  const items = useMemo(
    () =>
      attentionItems({
        isAdmin,
        apps: data.apps.map((app) => ({ ...app, label: homeName(app) })),
        failedJobs: data.failedJobs,
        accountRows: data.accountRows,
        dismissedAccountRows: dismissed,
        deployCopy: data.deployCopy,
        downgrade: data.downgrade,
        ...(leftForAdmin === undefined ? {} : { leftForAdmin }),
      }),
    [data, isAdmin, dismissed, leftForAdmin],
  );
  return {
    data,
    isAdmin,
    items,
    dismissAccountRow: (row) => {
      if (row.dismissible) dismiss(accountRowKey(row));
    },
  };
}

/**
 * The click handler of the sidebar's Home and the logo: goes to `/` marked
 * as a Home click, so Home stays even with no app installed (see
 * `home-landing.ts`). Modified clicks keep the browser's behaviour.
 */
export function useHomeClick(): (event: MouseEvent<HTMLElement>) => void {
  const router = useRouter();
  return (event) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    void router.navigate({ to: "/", state: homeClickState });
  };
}

/**
 * The router types history state by its own keys only; the Home click's
 * mark travels beside them.
 */
function homeClickState(): HistoryState {
  return Object.assign<HistoryState, typeof HOME_CLICK_STATE>({}, HOME_CLICK_STATE);
}
