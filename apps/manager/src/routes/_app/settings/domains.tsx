import { createFileRoute } from "@tanstack/react-router";
import { GatewayCard } from "../../../components/gateway-card";
import { SETTINGS_CRUMB, SETTINGS_PAGES } from "../../../components/navigation";
import { PageHeader } from "../../../components/page-header";
import { Section } from "../../../components/section";
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
  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.domains.label}
        description={SETTINGS_PAGES.domains.description}
        parents={[SETTINGS_CRUMB]}
      />
      <Section title="External domains">
        <GatewayCard view={view} isAdmin={viewer.role === "admin"} />
      </Section>
    </>
  );
}
