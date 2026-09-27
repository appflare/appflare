import { createFileRoute } from "@tanstack/react-router";
import { listCatalogs } from "../../../catalog/catalogs.functions";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { CatalogsSettingsView } from "../../../components/settings-pages";

/**
 * `/settings/catalogs`: the catalogs apps come from. Admins add, edit,
 * turn off and remove them; members see the list.
 */
export const Route = createFileRoute("/_app/settings/catalogs")({
  staticData: { title: SETTINGS_PAGES.catalogs.label },
  loader: () => listCatalogs(),
  component: CatalogsPage,
});

function CatalogsPage() {
  const catalogs = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <CatalogsSettingsView catalogs={catalogs} isAdmin={viewer.role === "admin"} />;
}
