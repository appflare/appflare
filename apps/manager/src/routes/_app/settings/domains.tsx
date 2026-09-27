import { createFileRoute } from "@tanstack/react-router";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { DomainsSettingsView } from "../../../components/settings-pages";
import { getGatewayView } from "../../../gateway/gateway.functions";

/**
 * `/settings/domains`: the gateway zone that serves external domains
 * (Cloudflare for SaaS). Custom domains in the account's own zones need no
 * setting; they are added on each app's Domains and email tab.
 */
export const Route = createFileRoute("/_app/settings/domains")({
  staticData: { title: SETTINGS_PAGES.domains.label },
  loader: () => getGatewayView(),
  component: DomainsSettingsPage,
});

function DomainsSettingsPage() {
  const view = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <DomainsSettingsView view={view} isAdmin={viewer.role === "admin"} />;
}
