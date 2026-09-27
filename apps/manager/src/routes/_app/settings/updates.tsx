import { createFileRoute } from "@tanstack/react-router";
import { getAutoUpdateSettings } from "../../../auto-update/auto-update.functions";
import { getManagerUpdate } from "../../../catalog/manager-releases.functions";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { UpdatesSettingsView } from "../../../components/settings-pages";
import { getManagerVersions } from "../../../jobs/self-update/rollback.functions";

/**
 * `/settings/updates` (Updates): whether apps update on their own by
 * default, then Appflare itself: the running version, the newest release,
 * the self-update and whether Appflare updates itself (admins), and its
 * recent versions with the rollback to an older one (admins). The sidebar's
 * Appflare card and the account menu link here.
 */
export const Route = createFileRoute("/_app/settings/updates")({
  staticData: { title: SETTINGS_PAGES.updates.label },
  loader: async () => {
    const [autoUpdate, managerUpdate, versions] = await Promise.all([
      getAutoUpdateSettings(),
      getManagerUpdate(),
      getManagerVersions(),
    ]);
    return { autoUpdate, managerUpdate, versions };
  },
  component: UpdatesSettingsPage,
});

function UpdatesSettingsPage() {
  const data = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <UpdatesSettingsView {...data} isAdmin={viewer.role === "admin"} />;
}
