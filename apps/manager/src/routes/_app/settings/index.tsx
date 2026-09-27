import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { getAutoUpdateSettings } from "../../../auto-update/auto-update.functions";
import { settingsPageForAnchor } from "../../../components/navigation";
import { GeneralSettingsView } from "../../../components/settings-pages";
import { getDangerZoneState } from "../../../danger/danger.functions";

/**
 * `/settings` (General): whether apps update on their own by default, and
 * the manager's danger zone (owner only: rotate the auth secret, remove
 * Appflare from the account). The other settings pages are listed under
 * Settings in the sidebar.
 */
export const Route = createFileRoute("/_app/settings/")({
  staticData: { title: "Settings" },
  loader: async () => {
    const [autoUpdate, danger] = await Promise.all([getAutoUpdateSettings(), getDangerZoneState()]);
    return { autoUpdate, danger };
  },
  component: GeneralSettingsPage,
});

function GeneralSettingsPage() {
  const { autoUpdate, danger } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const router = useRouter();
  // Links from before Settings had pages point at sections of this one
  // (`/settings#appflare-updates`); they open the page that section became.
  useEffect(() => {
    const page = settingsPageForAnchor(window.location.hash);
    if (page !== null) void router.navigate({ href: page, replace: true });
  }, [router]);
  return <GeneralSettingsView autoUpdate={autoUpdate} danger={danger} viewer={viewer} />;
}
