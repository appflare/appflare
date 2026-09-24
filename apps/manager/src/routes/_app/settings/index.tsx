import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { getAutoUpdateSettings } from "../../../auto-update/auto-update.functions";
import { AutomaticUpdatesCard } from "../../../auto-update/automatic-updates-card";
import { SETTINGS_PAGES, settingsPageForAnchor } from "../../../components/navigation";
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
  const router = useRouter();
  // Links from before Settings had pages point at sections of this one
  // (`/settings#appflare-updates`); they open the page that section became.
  useEffect(() => {
    const page = settingsPageForAnchor(window.location.hash);
    if (page !== null) void router.navigate({ href: page, replace: true });
  }, [router]);
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
