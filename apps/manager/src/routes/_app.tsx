import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useMemo } from "react";
import { AppShell } from "../components/app-shell";
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
 * exists or while the Cloudflare token is not configured. This is
 * UX; each server function still enforces its own guard. The loader reads,
 * in one call, the installs and what needs attention (Home lists them, the
 * sidebar counts them and lists the apps), Appflare's own version, and how
 * many removed apps there are (Settings lists that page only then). It
 * reruns when a page invalidates the router after an action and when a job
 * followed on screen finishes (`useLiveJob`), and otherwise at most once a
 * minute as pages change, not on every click.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: () => enterApp(),
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
      <Outlet />
    </AppShell>
  );
}
