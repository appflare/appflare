import { createFileRoute } from "@tanstack/react-router";
import { DocsLink } from "../../../components/docs-link";
import { SETTINGS_CRUMB, SETTINGS_PAGES } from "../../../components/navigation";
import { PageHeader } from "../../../components/page-header";
import { UsageDataCard } from "../../../components/usage-data-card";
import { getTelemetryStatus } from "../../../telemetry/telemetry.functions";

/** `/settings/usage-data`: the anonymous daily report, its switch, and a preview of it. */
export const Route = createFileRoute("/_app/settings/usage-data")({
  staticData: { title: SETTINGS_PAGES.usageData.label },
  loader: () => getTelemetryStatus(),
  component: UsageDataPage,
});

function UsageDataPage() {
  const telemetry = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.usageData.label}
        titleAction={<DocsLink topic="usageData" />}
        description={SETTINGS_PAGES.usageData.description}
        parents={[SETTINGS_CRUMB]}
      />
      <UsageDataCard status={telemetry} isAdmin={viewer.role === "admin"} />
    </>
  );
}
