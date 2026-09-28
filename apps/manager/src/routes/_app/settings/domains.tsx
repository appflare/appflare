import { createFileRoute } from "@tanstack/react-router";
import { loadAddressView } from "../../../components/manager-address-section";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { DomainsSettingsView } from "../../../components/settings-pages";
import { getGatewayView } from "../../../gateway/gateway.functions";

/**
 * `/settings/domains`: Appflare's own address (admins), and the gateway zone
 * that serves external domains (Cloudflare for SaaS). Custom domains in the
 * account's own zones need no setting; they are added on each app's Domains
 * and email tab.
 */
export const Route = createFileRoute("/_app/settings/domains")({
  staticData: { title: SETTINGS_PAGES.domains.label },
  loader: async ({ context }) => {
    const admin = context.viewer.role === "admin";
    const [view, address] = await Promise.all([
      getGatewayView(),
      admin ? loadAddressView(context.accountId) : null,
    ]);
    return { view, address };
  },
  component: DomainsSettingsPage,
});

function DomainsSettingsPage() {
  const { view, address } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <DomainsSettingsView view={view} address={address} isAdmin={viewer.role === "admin"} />;
}
