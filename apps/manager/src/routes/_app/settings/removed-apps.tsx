import { createFileRoute } from "@tanstack/react-router";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { RemovedAppsSettingsView } from "../../../components/settings-pages";
import { listRemovedApps } from "../../../installs/removed-apps.functions";

/**
 * `/settings/removed-apps`: uninstalled apps that still keep data resources
 * in the account, with what each kept. Admins can delete what an app kept
 * (a job; its log opens) or forget the app, which only hides it here: the
 * resources stay in the account. Uninstalled apps that kept nothing are not
 * listed.
 */
export const Route = createFileRoute("/_app/settings/removed-apps")({
  staticData: { title: SETTINGS_PAGES.removedApps.label },
  loader: () => listRemovedApps(),
  component: RemovedAppsPage,
});

function RemovedAppsPage() {
  const rows = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <RemovedAppsSettingsView rows={rows} isAdmin={viewer.role === "admin"} />;
}
