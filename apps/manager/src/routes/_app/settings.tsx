import { Text } from "@cloudflare/kumo";
import { createFileRoute } from "@tanstack/react-router";
import { getManagerUpdate } from "../../catalog/manager-releases.functions";
import { AccessCard } from "../../components/access-card";
import { AppflareUpdatesCard } from "../../components/appflare-updates-card";
import { CloudflareTokenCard } from "../../components/cloudflare-token-card";
import { PageHeader } from "../../components/page-header";
import { PasskeysSection } from "../../components/passkeys-section";
import { PlaceholderCard } from "../../components/placeholder-card";
import { UsersSection } from "../../components/users-section";
import { getAccessStatus } from "../../server/access.functions";
import { listPasskeys } from "../../server/passkeys.functions";
import { getTokenStatus } from "../../server/token.functions";
import { listUsers } from "../../server/users.functions";

/**
 * `/settings`: users, your passkeys, the Cloudflare token, Cloudflare Access
 * protection, and Appflare's own updates.
 */
export const Route = createFileRoute("/_app/settings")({
  staticData: { title: "Settings" },
  loader: async ({ context }) => {
    const [users, passkeys, tokenStatus, accessStatus, managerUpdate] = await Promise.all([
      context.viewer.role === "admin" ? listUsers() : null,
      listPasskeys(),
      getTokenStatus(),
      getAccessStatus(),
      getManagerUpdate(),
    ]);
    return { users, passkeys, tokenStatus, accessStatus, managerUpdate };
  },
  component: SettingsPage,
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <Text variant="heading" as="h2">
        {title}
      </Text>
      {children}
    </section>
  );
}

function SettingsPage() {
  const { users, passkeys, tokenStatus, accessStatus, managerUpdate } = Route.useLoaderData();
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
      <Section title="Cloudflare Access">
        <AccessCard
          status={accessStatus}
          isAdmin={viewer.role === "admin"}
          viewerEmail={viewer.email}
        />
      </Section>
      <Section title="Appflare updates">
        <AppflareUpdatesCard state={managerUpdate} isAdmin={viewer.role === "admin"} />
      </Section>
      <Section title="Danger zone">
        {/* TODO: danger-zone actions (for example removing the manager's stored token). */}
        <PlaceholderCard title="Danger zone" description="Irreversible actions on this manager." />
      </Section>
    </>
  );
}
