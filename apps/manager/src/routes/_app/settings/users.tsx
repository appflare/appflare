import { createFileRoute } from "@tanstack/react-router";
import { AccessCard } from "../../../components/access-card";
import { SETTINGS_CRUMB, SETTINGS_PAGES } from "../../../components/navigation";
import { PageHeader } from "../../../components/page-header";
import { PasskeysSection } from "../../../components/passkeys-section";
import { Section } from "../../../components/section";
import { AddUserDialog, UsersSection } from "../../../components/users-section";
import { getAccessStatus } from "../../../server/access.functions";
import { listPasskeys } from "../../../server/passkeys.functions";
import { listUsers } from "../../../server/users.functions";

/**
 * `/settings/users`: the users (admins add them), the signed-in user's own
 * passkeys, and Cloudflare Access in front of the manager.
 */
export const Route = createFileRoute("/_app/settings/users")({
  staticData: { title: SETTINGS_PAGES.users.label },
  loader: async ({ context }) => {
    const [users, passkeys, accessStatus] = await Promise.all([
      context.viewer.role === "admin" ? listUsers() : null,
      listPasskeys(),
      getAccessStatus(),
    ]);
    return { users, passkeys, accessStatus };
  },
  component: UsersSettingsPage,
});

function UsersSettingsPage() {
  const { users, passkeys, accessStatus } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.users.label}
        description={SETTINGS_PAGES.users.description}
        parents={[SETTINGS_CRUMB]}
      />
      <Section title="Users" actions={users !== null ? <AddUserDialog /> : undefined}>
        <UsersSection users={users} viewerId={viewer.id} />
      </Section>
      <Section title="Your passkeys">
        <PasskeysSection passkeys={passkeys} />
      </Section>
      <Section title="Cloudflare Access">
        <AccessCard
          status={accessStatus}
          isAdmin={viewer.role === "admin"}
          viewerEmail={viewer.email}
        />
      </Section>
    </>
  );
}
