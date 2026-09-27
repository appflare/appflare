import { createFileRoute } from "@tanstack/react-router";
import { getAutoUpdateSettings } from "../../../auto-update/auto-update.functions";
import { getManagerUpdate } from "../../../catalog/manager-releases.functions";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { AppflareUpdatesSettingsView } from "../../../components/settings-pages";
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
  const data = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <AppflareUpdatesSettingsView {...data} isAdmin={viewer.role === "admin"} />;
}
