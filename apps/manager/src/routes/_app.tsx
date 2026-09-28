import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useMemo } from "react";
import { appEntryMemo } from "../components/app-entry-memo";
import { AppShell } from "../components/app-shell";
import { ShellContent } from "../components/page-pending";
import { sidebarApps } from "../components/sidebar-apps-list";
import { appSignals, attentionBadge } from "../home/attention";
import { getLayoutData } from "../home/layout-data.functions";
import { useAttention } from "../home/use-attention";
import { enterApp } from "../server/gate.functions";

/** How long the layout's data serves page changes before it is read again. */
const LAYOUT_STALE_MS = 60_000;

/**
 * Pathless layout for every signed-in page. `enterApp` returns the viewer or
 * redirects: to `/login` without a session, to `/setup` before the owner
 * exists or while the Cloudflare token is not configured, either way with
 * the page asked for as `?returnTo=`, opened once signed in. This is
 * UX; each server function still enforces its own guard, so its answer is
 * kept in the browser for 30 s (`appEntryMemo`) and page changes within that
 * time start reading their data at once. The loader reads,
 * in one call, the installs and what needs attention (Home lists them, the
 * sidebar counts them and lists the apps), Appflare's own version, and how
 * many removed apps there are (Settings lists that page only then). It
 * reruns when a page invalidates the router after an action and when a job
 * followed on screen finishes (`useLiveJob`), and otherwise at most once a
 * minute as pages change, not on every click. While a page below it loads,
 * the shell stays and the loading indicator shows in the page's place.
 */
export const Route = createFileRoute("/_app")({
  // The page asked for, as the browser holds it: its `#section` never reaches
  // the server otherwise, and must survive signing in.
  beforeLoad: async ({ location }) => {
    const held = appEntryMemo.recall(Date.now());
    if (held !== null) return held;
    const entry = await enterApp({ data: { returnTo: location.href } });
    appEntryMemo.remember(entry, Date.now());
    return entry;
  },
  onLeave: () => appEntryMemo.forget(),
  loader: () => getLayoutData(),
  staleTime: LAYOUT_STALE_MS,
  component: AppLayout,
});

function AppLayout() {
  const { viewer } = Route.useRouteContext();
  const { data, items } = useAttention();
  const apps = useMemo(() => sidebarApps(data.apps, appSignals(items)), [data.apps, items]);
  return (
    <AppShell
      viewer={viewer}
      manager={data.manager}
      removedApps={data.removedApps}
      apps={apps}
      badge={attentionBadge(items)}
    >
      <ShellContent>
        <Outlet />
      </ShellContent>
    </AppShell>
  );
}
