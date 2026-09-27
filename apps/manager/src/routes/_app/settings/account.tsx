import { createFileRoute } from "@tanstack/react-router";
import { getAccountCapabilities } from "../../../capabilities/capabilities.functions";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { AccountSettingsView } from "../../../components/settings-pages";
import { redirectMovedSettings } from "../../../components/settings-redirect";
import { getDangerZoneState } from "../../../danger/danger.functions";
import { getChecklistData } from "../../../onboarding/checklist.functions";
import { getTokenStatus } from "../../../server/token.functions";

/**
 * `/settings/account` (Your account): the Cloudflare account and the token
 * Appflare uses (admins rotate it), the onboarding checklist, what the
 * account can run, and, for the owner only, the danger zone. Links to the
 * sections that moved to Building apps, and to the checklist's rows under
 * their old anchors, are sent on (`settingsRedirect`).
 */
export const Route = createFileRoute("/_app/settings/account")({
  staticData: { title: SETTINGS_PAGES.account.label },
  beforeLoad: ({ location }) => redirectMovedSettings(location),
  loader: async ({ context }) => {
    const [tokenStatus, capabilities, checklist, danger] = await Promise.all([
      getTokenStatus(),
      getAccountCapabilities(),
      getChecklistData(),
      context.viewer.isOwner ? getDangerZoneState() : null,
    ]);
    return { tokenStatus, capabilities, checklist, danger };
  },
  component: AccountSettingsPage,
});

function AccountSettingsPage() {
  const data = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <AccountSettingsView {...data} viewer={viewer} />;
}
