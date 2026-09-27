import { createFileRoute } from "@tanstack/react-router";
import { getAccountCapabilities } from "../../../capabilities/capabilities.functions";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { AccountSettingsView } from "../../../components/settings-pages";
import { getChecklistData } from "../../../onboarding/checklist.functions";
import { getSandboxStatus } from "../../../server/sandbox.functions";
import { getTokenStatus } from "../../../server/token.functions";

/**
 * `/settings/account`: the Cloudflare account and the token Appflare uses
 * (admins rotate it), the onboarding checklist, what the account can run
 * (R2, Containers, Workers plan), sandbox builds, and GitHub access.
 */
export const Route = createFileRoute("/_app/settings/account")({
  staticData: { title: SETTINGS_PAGES.account.label },
  loader: async () => {
    const [tokenStatus, capabilities, sandboxStatus, checklist] = await Promise.all([
      getTokenStatus(),
      getAccountCapabilities(),
      getSandboxStatus(),
      getChecklistData(),
    ]);
    return { tokenStatus, capabilities, sandboxStatus, checklist };
  },
  component: AccountSettingsPage,
});

function AccountSettingsPage() {
  const data = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <AccountSettingsView {...data} isAdmin={viewer.role === "admin"} />;
}
