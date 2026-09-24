import { createFileRoute } from "@tanstack/react-router";
import { AccountCapabilitiesCard } from "../../../capabilities/account-capabilities-card";
import { getAccountCapabilities } from "../../../capabilities/capabilities.functions";
import { CloudflareTokenCard } from "../../../components/cloudflare-token-card";
import { SETTINGS_CRUMB, SETTINGS_PAGES } from "../../../components/navigation";
import { PageHeader } from "../../../components/page-header";
import { SandboxCard } from "../../../components/sandbox-card";
import { getChecklistData } from "../../../onboarding/checklist.functions";
import { OnboardingChecklistCard } from "../../../onboarding/onboarding-checklist";
import { getSandboxStatus } from "../../../server/sandbox.functions";
import { getTokenStatus } from "../../../server/token.functions";

/**
 * `/settings/account`: the Cloudflare account and the token Appflare uses
 * (admins rotate it), what the account can run (R2, Containers, Workers
 * plan), the onboarding checklist, and sandbox builds.
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
  const { tokenStatus, capabilities, sandboxStatus, checklist } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  const isAdmin = viewer.role === "admin";
  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.account.label}
        description={SETTINGS_PAGES.account.description}
        parents={[SETTINGS_CRUMB]}
      />
      <CloudflareTokenCard status={tokenStatus} canRotate={isAdmin} />
      <OnboardingChecklistCard data={checklist} isAdmin={isAdmin} />
      <AccountCapabilitiesCard view={capabilities} isAdmin={isAdmin} />
      <SandboxCard status={sandboxStatus} isAdmin={isAdmin} />
    </>
  );
}
