import { Text } from "@cloudflare/kumo";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "../../components/page-header";
import { PlaceholderCard } from "../../components/placeholder-card";
import { UsersSection } from "../../components/users-section";
import { listUsers } from "../../server/users.functions";

/** `/settings`. Only "Users" is built so far. */
export const Route = createFileRoute("/_app/settings")({
  loader: async ({ context }) => ({
    users: context.viewer.role === "admin" ? await listUsers() : null,
  }),
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
  const { users } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return (
    <>
      <PageHeader title="Settings" description="Manager configuration and access." />
      <Section title="Users">
        <UsersSection users={users} viewerId={viewer.id} />
      </Section>
      <Section title="Cloudflare token">
        {/* TODO: rotate CF_API_TOKEN with the setup wizard's verify-and-store function. */}
        <PlaceholderCard
          title="Cloudflare API token"
          description="Verify and rotate the account API token Appflare uses to manage apps."
        />
      </Section>
      <Section title="Cloudflare Access">
        {/* TODO: Access toggle: self-hosted Access app + JWT verification. */}
        <PlaceholderCard
          title="Protect this manager with Cloudflare Access"
          description="Put the manager behind a Cloudflare Access policy for your admins' emails."
        />
      </Section>
      <Section title="Appflare updates">
        {/* TODO: self-update from the release feed. */}
        <PlaceholderCard
          title="Self-update"
          description="Update this manager to a new signed release, with rollback."
        />
      </Section>
      <Section title="Danger zone">
        {/* TODO: danger-zone actions (for example removing the manager's stored token). */}
        <PlaceholderCard title="Danger zone" description="Irreversible actions on this manager." />
      </Section>
    </>
  );
}
