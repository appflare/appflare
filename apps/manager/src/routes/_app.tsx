import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "../components/app-shell";
import { getViewer } from "../server/session.functions";

/**
 * Pathless layout for every signed-in page. `getViewer` calls `requireSession()`,
 * which redirects to `/login` (and `/login` on to `/setup` before the first admin
 * exists). This is UX; each server function still enforces its own guard.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async () => ({ viewer: await getViewer() }),
  component: AppLayout,
});

function AppLayout() {
  const { viewer } = Route.useRouteContext();
  return (
    <AppShell viewer={viewer}>
      <Outlet />
    </AppShell>
  );
}
