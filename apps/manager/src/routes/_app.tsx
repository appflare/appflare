import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "../components/app-shell";
import { enterApp } from "../server/gate.functions";

/**
 * Pathless layout for every signed-in page. `enterApp` returns the viewer or
 * redirects: to `/login` without a session, to `/setup` before the first admin
 * exists or while the Cloudflare token is not configured. This is
 * UX; each server function still enforces its own guard.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async () => ({ viewer: await enterApp() }),
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
