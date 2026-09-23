import { Text } from "@cloudflare/kumo";
import { createFileRoute } from "@tanstack/react-router";
import { getManagerUpdate } from "../../catalog/manager-releases.functions";
import { AppflareUpdatesCard } from "../../components/appflare-updates-card";
import { CloudflareTokenCard } from "../../components/cloudflare-token-card";
import { PageHeader } from "../../components/page-header";
import { PlaceholderCard } from "../../components/placeholder-card";
import { UsersSection } from "../../components/users-section";
import { getTokenStatus } from "../../server/token.functions";
import { listUsers } from "../../server/users.functions";

/** `/settings`: users, the Cloudflare token, and Appflare's own updates. */
export const Route = createFileRoute("/_app/settings")({
  staticData: { title: "Settings" },
  loader: async ({ context }) => {
    const [users, tokenStatus, managerUpdate] = await Promise.all([
      context.viewer.role === "admin" ? listUsers() : null,
      getTokenStatus(),
      getManagerUpdate(),
    ]);
    return { users, tokenStatus, managerUpdate };
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
  const { users, tokenStatus, managerUpdate } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return (
    <>
      <PageHeader title="Settings" description="Manager configuration and access." />
      <Section title="Users">
        <UsersSection users={users} viewerId={viewer.id} />
      </Section>
      <Section title="Cloudflare token">
        <CloudflareTokenCard status={tokenStatus} canRotate={viewer.role === "admin"} />
      </Section>
      <Section title="Cloudflare Access">
        {/* TODO: Access toggle: self-hosted Access app + JWT verification. */}
        <PlaceholderCard
          title="Protect this manager with Cloudflare Access"
          description="Put the manager behind a Cloudflare Access policy for your admins' emails."
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
