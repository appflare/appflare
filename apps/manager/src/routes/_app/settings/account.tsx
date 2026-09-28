import { createFileRoute } from "@tanstack/react-router";
import { getCapabilityRowsData } from "../../../capabilities/capability-rows.functions";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { AccountSettingsView } from "../../../components/settings-pages";
import { redirectMovedSettings } from "../../../components/settings-redirect";
import { getDangerZoneState } from "../../../danger/danger.functions";
import { getTokenStatus } from "../../../server/token.functions";

/**
 * `/settings/account` (Your account): the Cloudflare account and the token
 * Appflare uses (admins rotate it) with the link that makes appflare.dev open
 * this Appflare at the address in the address bar, what the account can run,
 * and, for the owner only, the danger zone. Links to the sections that moved
 * to Building apps, and to the account setup list and its rows under their
 * old anchors, are sent on (`settingsRedirect`).
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
  // The address this browser uses (an Access hostname, a custom domain or
  // workers.dev), which is the one appflare.dev should send it back to.
  return <AccountSettingsView {...data} viewer={viewer} managerUrl={window.location.origin} />;
}
