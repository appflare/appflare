import { createFileRoute } from "@tanstack/react-router";
import { getAutoUpdateSettings } from "../../../auto-update/auto-update.functions";
import { AutomaticUpdatesCard } from "../../../auto-update/automatic-updates-card";
import { getManagerUpdate } from "../../../catalog/manager-releases.functions";
import { AppflareUpdatesCard } from "../../../components/appflare-updates-card";
import { SETTINGS_CRUMB, SETTINGS_PAGES } from "../../../components/navigation";
import { PageHeader } from "../../../components/page-header";

/**
 * `/settings/appflare-updates`: the running version, the newest release,
 * the self-update (admins), and whether Appflare updates itself. The home
 * page's list of pending updates and the sidebar link here.
 */
export const Route = createFileRoute("/_app/settings/appflare-updates")({
  staticData: { title: SETTINGS_PAGES.appflareUpdates.label },
  loader: async () => {
    const [managerUpdate, autoUpdate] = await Promise.all([
      getManagerUpdate(),
      getAutoUpdateSettings(),
    ]);
    return { managerUpdate, autoUpdate };
  },
  component: AppflareUpdatesPage,
});

function AppflareUpdatesPage() {
  const { managerUpdate, autoUpdate } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const isAdmin = viewer.role === "admin";
  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.appflareUpdates.label}
        description={SETTINGS_PAGES.appflareUpdates.description}
        parents={[SETTINGS_CRUMB]}
      />
      <AppflareUpdatesCard state={managerUpdate} isAdmin={isAdmin} />
      <AutomaticUpdatesCard settings={autoUpdate} isAdmin={isAdmin} which="manager" />
    </>
  );
}
