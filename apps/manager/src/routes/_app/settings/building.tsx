import { createFileRoute } from "@tanstack/react-router";
import { getAccountCapabilities } from "../../../capabilities/capabilities.functions";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { BuildingSettingsView } from "../../../components/settings-pages";
import { getSandboxStatus } from "../../../server/sandbox.functions";

/**
 * `/settings/building` (Building apps): sandbox builds, which build apps
 * that have no ready-made release in the account (admins enable, update and
 * disable them), and the GitHub tokens for private repositories (admins).
 * The account's capabilities come along: they decide what keeps sandbox
 * builds from working.
 */
export const Route = createFileRoute("/_app/settings/building")({
  staticData: { title: SETTINGS_PAGES.building.label },
  loader: async () => {
    const [sandboxStatus, capabilities] = await Promise.all([
      getSandboxStatus(),
      getAccountCapabilities(),
    ]);
    return { sandboxStatus, capabilities };
  },
  component: BuildingSettingsPage,
});

function BuildingSettingsPage() {
  const data = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <BuildingSettingsView {...data} isAdmin={viewer.role === "admin"} />;
}
