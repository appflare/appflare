import { createFileRoute } from "@tanstack/react-router";
import { listCatalogs } from "../../../catalog/catalogs.functions";
import { AddCatalogDialog, CatalogsList } from "../../../components/catalogs-settings";
import { SETTINGS_CRUMB, SETTINGS_PAGES } from "../../../components/navigation";
import { PageHeader } from "../../../components/page-header";

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
  const isAdmin = viewer.role === "admin";
  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.catalogs.label}
        description={SETTINGS_PAGES.catalogs.description}
        parents={[SETTINGS_CRUMB]}
        actions={
          isAdmin ? (
            <AddCatalogDialog customCount={catalogs.filter((c) => !c.official).length} />
          ) : undefined
        }
      />
      <CatalogsList catalogs={catalogs} isAdmin={isAdmin} />
    </>
  );
}
