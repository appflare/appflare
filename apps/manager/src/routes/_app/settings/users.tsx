import { createFileRoute } from "@tanstack/react-router";
import { AccessCard } from "../../../components/access-card";
import { SETTINGS_CRUMB, SETTINGS_PAGES } from "../../../components/navigation";
import { PageHeader } from "../../../components/page-header";
import { PasskeysSection } from "../../../components/passkeys-section";
import { PasswordRecoveryCard } from "../../../components/password-recovery-card";
import { Section } from "../../../components/section";
import { AddUserDialog, UsersSection } from "../../../components/users-section";
import { getAccessStatus } from "../../../server/access.functions";
import { listPasskeys } from "../../../server/passkeys.functions";
import { getPasswordRecoverySettings } from "../../../server/recovery.functions";
import { listUsers } from "../../../server/users.functions";

/**
 * `/settings/users`: the users (admins add them and reset their passwords;
 * the owner changes roles, deletes users and transfers ownership), how a
 * forgotten password is recovered, the signed-in user's own passkeys, and
 * Cloudflare Access in front of the manager.
 */
export const Route = createFileRoute("/_app/settings/users")({
  staticData: { title: SETTINGS_PAGES.users.label },
  loader: async ({ context }) => {
    const admin = context.viewer.role === "admin";
    const [users, recovery, passkeys, accessStatus] = await Promise.all([
      admin ? listUsers() : null,
      admin ? getPasswordRecoverySettings() : null,
      listPasskeys(),
      getAccessStatus(),
    ]);
    return { users, recovery, passkeys, accessStatus };
  },
  component: UsersSettingsPage,
});

function UsersSettingsPage() {
  const { users, recovery, passkeys, accessStatus } = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.users.label}
        description={SETTINGS_PAGES.users.description}
        parents={[SETTINGS_CRUMB]}
      />
      <Section title="Users" actions={users !== null ? <AddUserDialog /> : undefined}>
        <UsersSection
          users={users}
          viewerId={viewer.id}
          // From the list, which heals a missing owner as it loads (users.server.ts).
          viewerIsOwner={users?.some((u) => u.id === viewer.id && u.isOwner) ?? false}
          emailReset={recovery?.email.enabled ?? false}
        />
      </Section>
      {recovery !== null && (
        <Section id="forgotten-passwords" title="Forgotten passwords">
          <PasswordRecoveryCard settings={recovery} />
        </Section>
      )}
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
