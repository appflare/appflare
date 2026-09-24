import { Banner } from "@cloudflare/kumo";
import { InfoIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { SETTINGS_CRUMB, SETTINGS_PAGES } from "../../../components/navigation";
import { AddChannelDialog, NotificationChannels } from "../../../components/notification-channels";
import { PageHeader } from "../../../components/page-header";
import { NOTIFICATION_COPY } from "../../../notifications/channels";
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
  return (
    <>
      <PageHeader
        title={SETTINGS_PAGES.notifications.label}
        description={SETTINGS_PAGES.notifications.description}
        parents={[SETTINGS_CRUMB]}
        actions={channels === null ? undefined : <AddChannelDialog />}
      />
      {channels === null ? (
        <Banner
          variant="secondary"
          icon={<InfoIcon weight="fill" />}
          title={NOTIFICATION_COPY.membersOnly}
        />
      ) : (
        <NotificationChannels channels={channels} />
      )}
    </>
  );
}
