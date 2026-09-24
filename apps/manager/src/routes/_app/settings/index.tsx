import { createFileRoute } from "@tanstack/react-router";
import { getAutoUpdateSettings } from "../../../auto-update/auto-update.functions";
import { AutomaticUpdatesCard } from "../../../auto-update/automatic-updates-card";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { PageHeader } from "../../../components/page-header";
import { PlaceholderCard } from "../../../components/placeholder-card";
import { Section } from "../../../components/section";

/**
 * `/settings` (General): whether apps update on their own by default, and
 * the manager's danger zone. The other settings pages are listed under
 * Settings in the sidebar.
 */
export const Route = createFileRoute("/_app/settings/")({
  staticData: { title: "Settings" },
  loader: () => getAutoUpdateSettings(),
  component: GeneralSettingsPage,
});

function GeneralSettingsPage() {
  const autoUpdate = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return (
    <>
      <PageHeader title="Settings" description={SETTINGS_PAGES.general.description} />
      <Section title="Automatic updates">
        <AutomaticUpdatesCard
          settings={autoUpdate}
          isAdmin={viewer.role === "admin"}
          which="apps"
        />
      </Section>
      <Section title="Danger zone">
        {/* TODO: danger-zone actions (for example removing the manager's stored token). */}
        <PlaceholderCard title="Danger zone" description="Irreversible actions on this manager." />
      </Section>
    </>
  );
}
