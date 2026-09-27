import { createFileRoute } from "@tanstack/react-router";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { UsersSettingsView } from "../../../components/settings-pages";
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
  const data = Route.useLoaderData();
  const { viewer } = Route.useRouteContext();
  return <UsersSettingsView {...data} viewer={viewer} />;
}
