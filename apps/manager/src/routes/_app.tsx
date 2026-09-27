import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "../components/app-shell";
import { getPendingUpdates } from "../installs/pending-updates.functions";
import { enterApp } from "../server/gate.functions";

/**
 * Pathless layout for every signed-in page. `enterApp` returns the viewer or
 * redirects: to `/login` without a session, to `/setup` before the owner
 * exists or while the Cloudflare token is not configured. This is
 * UX; each server function still enforces its own guard. The loader reads,
 * in one call, the pending updates the sidebar counts and the home page
 * lists, and how many removed apps there are (Settings lists that page only
 * then); it reruns on navigation and whenever a page invalidates the router
 * after an action, so both follow finished jobs.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: () => enterApp(),
  loader: () => getPendingUpdates(),
  component: AppLayout,
});

function AppLayout() {
  const { viewer } = Route.useRouteContext();
  const { removedApps, ...pending } = Route.useLoaderData();
  return (
    <AppShell viewer={viewer} pending={pending} removedApps={removedApps}>
      <Outlet />
    </AppShell>
  );
}
