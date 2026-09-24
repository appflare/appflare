import { LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { getAccountPlan } from "../../../account/plan.functions";
import { getManagerUpdate } from "../../../catalog/manager-releases.functions";
import { AccessCard } from "../../../components/access-card";
import { AppflareUpdatesCard } from "../../../components/appflare-updates-card";
import { CloudflareTokenCard } from "../../../components/cloudflare-token-card";
import { PageHeader } from "../../../components/page-header";
import { PasskeysSection } from "../../../components/passkeys-section";
import { PlaceholderCard } from "../../../components/placeholder-card";
import { SandboxCard } from "../../../components/sandbox-card";
import { UsageDataCard } from "../../../components/usage-data-card";
import { UsersSection } from "../../../components/users-section";
import { WorkersPlanCard } from "../../../components/workers-plan-card";
import { listRemovedApps } from "../../../installs/removed-apps.functions";
import { getAccessStatus } from "../../../server/access.functions";
import { listPasskeys } from "../../../server/passkeys.functions";
import { getSandboxStatus } from "../../../server/sandbox.functions";
import { getTokenStatus } from "../../../server/token.functions";
import { listUsers } from "../../../server/users.functions";
import { getTelemetryStatus } from "../../../telemetry/telemetry.functions";

/**
 * `/settings`: users, your passkeys, the Cloudflare token, the account's
 * Workers plan, Cloudflare Access protection, sandbox builds, Appflare's own
 * updates (`#appflare-updates`, which the home page's list of pending
 * updates links to), anonymous usage data, and the way to Removed apps.
 */
export const Route = createFileRoute("/_app/settings/")({
  staticData: { title: "Settings" },
  loader: async ({ context }) => {
    const [
      users,
      passkeys,
      tokenStatus,
      accountPlan,
      accessStatus,
      sandboxStatus,
      managerUpdate,
      removedApps,
      telemetry,
    ] = await Promise.all([
      context.viewer.role === "admin" ? listUsers() : null,
      listPasskeys(),
      getTokenStatus(),
      getAccountPlan(),
      getAccessStatus(),
      getSandboxStatus(),
      getManagerUpdate(),
      listRemovedApps(),
      getTelemetryStatus(),
    ]);
    return {
      users,
      passkeys,
      tokenStatus,
      accountPlan,
      accessStatus,
      sandboxStatus,
      managerUpdate,
      removedApps: removedApps.length,
      telemetry,
    };
  },
  component: SettingsPage,
});

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="grid scroll-mt-6 gap-3">
      <Text variant="heading" as="h2">
        {title}
      </Text>
      {children}
    </section>
  );
}

function SettingsPage() {
  const {
    users,
    passkeys,
    tokenStatus,
    accountPlan,
    accessStatus,
    sandboxStatus,
    managerUpdate,
    removedApps,
    telemetry,
  } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return (
    <>
      <PageHeader title="Settings" description="Manager configuration and access." />
      <Section title="Users">
        <UsersSection users={users} viewerId={viewer.id} />
      </Section>
      <Section title="Passkeys">
        <PasskeysSection passkeys={passkeys} />
      </Section>
      <Section title="Cloudflare token">
        <CloudflareTokenCard status={tokenStatus} canRotate={viewer.role === "admin"} />
      </Section>
      <Section title="Workers plan">
        <WorkersPlanCard plan={accountPlan} isAdmin={viewer.role === "admin"} />
      </Section>
      <Section title="Cloudflare Access">
        <AccessCard
          status={accessStatus}
          isAdmin={viewer.role === "admin"}
          viewerEmail={viewer.email}
        />
      </Section>
      <Section title="Sandbox builds">
        <SandboxCard status={sandboxStatus} isAdmin={viewer.role === "admin"} />
      </Section>
      <Section id="appflare-updates" title="Appflare updates">
        <AppflareUpdatesCard state={managerUpdate} isAdmin={viewer.role === "admin"} />
      </Section>
      <Section id="usage-data" title="Usage data">
        <UsageDataCard status={telemetry} isAdmin={viewer.role === "admin"} />
      </Section>
      <Section title="Removed apps">
        <LayerCard>
          <LayerCard.Primary className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <Text variant="secondary">
              {removedApps === 0
                ? "No removed apps to list. Apps you forgot are not counted, even when they still keep data."
                : `${removedApps} uninstalled app${removedApps === 1 ? " keeps" : "s keep"} data in the account and ${removedApps === 1 ? "is" : "are"} not forgotten.`}
            </Text>
            <LinkButton href="/settings/removed-apps" variant="secondary" icon={<ArrowRightIcon />}>
              Removed apps
            </LinkButton>
          </LayerCard.Primary>
        </LayerCard>
      </Section>
      <Section title="Danger zone">
        {/* TODO: danger-zone actions (for example removing the manager's stored token). */}
        <PlaceholderCard title="Danger zone" description="Irreversible actions on this manager." />
      </Section>
    </>
  );
}
