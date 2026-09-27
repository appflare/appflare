import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "../components/app-shell";
import { getPendingUpdates } from "../installs/pending-updates.functions";
import { enterApp } from "../server/gate.functions";

/**
 * Pathless layout for every signed-in page. `enterApp` returns the viewer or
 * redirects: to `/login` without a session, to `/setup` before the owner
 * exists or while the Cloudflare token is not configured. This is
 * UX; each server function still enforces its own guard. The loader reads
 * the pending updates the sidebar counts and the home page lists; it reruns
 * on navigation and whenever a page invalidates the router after an action,
 * so the count follows finished updates.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: () => enterApp(),
  loader: () => getPendingUpdates(),
  component: AppLayout,
});

function AppLayout() {
  const { viewer } = Route.useRouteContext();
  const pending = Route.useLoaderData();
  return (
    <AppShell viewer={viewer} pending={pending}>
      <Outlet />
    </AppShell>
  );
}
