import { createFileRoute } from "@tanstack/react-router";
import { getCapabilityRowsData } from "../../../capabilities/capability-rows.functions";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { AccountSettingsView } from "../../../components/settings-pages";
import { redirectMovedSettings } from "../../../components/settings-redirect";
import { getDangerZoneState } from "../../../danger/danger.functions";
import { getTokenStatus } from "../../../server/token.functions";

/**
 * `/settings/account` (Your account): the Cloudflare account and the token
 * Appflare uses (admins rotate it), what the account can run, and, for the
 * owner only, the danger zone. Links to the sections that moved to Building
 * apps, and to the account setup list and its rows under their old anchors,
 * are sent on (`settingsRedirect`).
 */
export const Route = createFileRoute("/_app/settings/account")({
  staticData: { title: SETTINGS_PAGES.account.label },
  beforeLoad: ({ location }) => redirectMovedSettings(location),
  loader: async ({ context }) => {
    const [tokenStatus, capabilities, danger] = await Promise.all([
      getTokenStatus(),
      getCapabilityRowsData(),
      context.viewer.isOwner ? getDangerZoneState() : null,
    ]);
    return { tokenStatus, capabilities, danger };
  },
  component: AccountSettingsPage,
});

function AccountSettingsPage() {
  const data = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <AccountSettingsView {...data} viewer={viewer} />;
}
