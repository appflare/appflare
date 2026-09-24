import { Banner, LinkButton } from "@cloudflare/kumo";
import { ArrowLeftIcon, InfoIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";
import { NotificationChannels } from "../../../components/notification-channels";
import { PageHeader } from "../../../components/page-header";
import { NOTIFICATION_COPY } from "../../../notifications/channels";
import { listNotificationChannels } from "../../../notifications/channels.functions";

/**
 * `/settings/notifications`: where Appflare sends messages about updates,
 * jobs and health. Admins manage the channels; members see a note.
 */
export const Route = createFileRoute("/_app/settings/notifications")({
  staticData: { title: "Notification channels" },
  loader: ({ context }) => (context.viewer.role === "admin" ? listNotificationChannels() : null),
  component: NotificationsPage,
});

function NotificationsPage() {
  const channels = Route.useLoaderData();
  return (
    <>
      <PageHeader
        title={NOTIFICATION_COPY.title}
        description={NOTIFICATION_COPY.description}
        actions={
          <LinkButton href="/settings" variant="secondary" icon={<ArrowLeftIcon />}>
            Settings
          </LinkButton>
        }
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
