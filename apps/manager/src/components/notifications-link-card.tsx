import { LayerCard, LinkButton, Text } from "@cloudflare/kumo";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { NOTIFICATION_COPY } from "../notifications/channels";

/** Settings: the way to Notification channels (`/settings/notifications`). */
export function NotificationsLinkCard() {
  return (
    <LayerCard>
      <LayerCard.Primary className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <Text variant="secondary">{NOTIFICATION_COPY.description}</Text>
        <LinkButton href="/settings/notifications" variant="secondary" icon={<ArrowRightIcon />}>
          {NOTIFICATION_COPY.title}
        </LinkButton>
      </LayerCard.Primary>
    </LayerCard>
  );
}
