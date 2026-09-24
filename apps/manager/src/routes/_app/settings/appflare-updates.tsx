import { createFileRoute } from "@tanstack/react-router";
import { getAutoUpdateSettings } from "../../../auto-update/auto-update.functions";
import { AutomaticUpdatesCard } from "../../../auto-update/automatic-updates-card";
import { getManagerUpdate } from "../../../catalog/manager-releases.functions";
import { AppflareUpdatesCard } from "../../../components/appflare-updates-card";
import { ManagerVersionsSection } from "../../../components/manager-versions-section";
import { SETTINGS_CRUMB, SETTINGS_PAGES } from "../../../components/navigation";
import { PageHeader } from "../../../components/page-header";
import { getManagerVersions } from "../../../jobs/self-update/rollback.functions";

/**
 * `/settings/appflare-updates`: the running version, the newest release,
 * the self-update (admins), whether Appflare updates itself, and Appflare's
 * own recent versions with the rollback to an older one (admins). The home
 * page's list of pending updates and the sidebar link here.
 */
export const Route = createFileRoute("/_app/settings/appflare-updates")({
  staticData: { title: SETTINGS_PAGES.appflareUpdates.label },
  loader: async () => {
    const [managerUpdate, autoUpdate, versions] = await Promise.all([
      getManagerUpdate(),
      getAutoUpdateSettings(),
      getManagerVersions(),
    ]);
    return { managerUpdate, autoUpdate, versions };
  },
  component: AppflareUpdatesPage,
});

function AppflareUpdatesPage() {
  const { managerUpdate, autoUpdate, versions } = Route.useLoaderData();
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
      <ManagerVersionsSection state={versions} isAdmin={isAdmin} current={managerUpdate.current} />
    </>
  );
}
