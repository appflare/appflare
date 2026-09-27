import { createFileRoute } from "@tanstack/react-router";
import { SETTINGS_PAGES } from "../../../components/navigation";
import { NotificationsSettingsView } from "../../../components/settings-pages";
import { listNotificationChannels } from "../../../notifications/channels.functions";

/**
 * `/settings/notifications`: where Appflare sends messages about updates,
 * jobs and health. Admins manage the channels; members see a note.
 */
export const Route = createFileRoute("/_app/settings/notifications")({
  staticData: { title: SETTINGS_PAGES.notifications.label },
  loader: ({ context }) => (context.viewer.role === "admin" ? listNotificationChannels() : null),
  component: NotificationsPage,
});

function NotificationsPage() {
  const channels = Route.useLoaderData();
  return <NotificationsSettingsView channels={channels} />;
}
