// The single-icon entries Phosphor documents: tests that render these logos in
// workerd then load four icons instead of the whole set.
import { DiscordLogoIcon } from "@phosphor-icons/react/dist/csr/DiscordLogo";
import { SlackLogoIcon } from "@phosphor-icons/react/dist/csr/SlackLogo";
import { TelegramLogoIcon } from "@phosphor-icons/react/dist/csr/TelegramLogo";
import { WebhooksLogoIcon } from "@phosphor-icons/react/dist/csr/WebhooksLogo";
import type { ComponentType } from "react";
import type { ChannelKind } from "../notifications/channels";

/**
 * The logo of each notification channel kind, from Phosphor's logo icons, so
 * a channel is recognised at a glance. Telegram, Slack and Discord are
 * trademarks of their respective companies; their logos appear here only to
 * identify the service a channel posts to.
 *
 * Every logo is decorative (`aria-hidden`): the kind's name is always written
 * next to it. `size` is the width and height in pixels. Telegram and Discord
 * are drawn in their brand blue; Slack's mark has no single brand colour
 * and takes the surrounding text colour, as does the generic webhook.
 */

export interface ChannelLogoProps {
  size?: number;
  className?: string;
}

const DEFAULT_SIZE = 20;

// Brand colours are the one deliberate exception to Kumo's semantic-tokens-only rule: a logo keeps its brand's colour.

/** Telegram's brand blue. */
export const TELEGRAM_BLUE = "#229ED9";

/** Discord's brand blue ("blurple"). */
export const DISCORD_BLURPLE = "#5865F2";

/** The logo never shrinks in a flex row; extra classes follow. */
function classes(className: string | undefined): string {
  return className === undefined ? "shrink-0" : `shrink-0 ${className}`;
}

/** Telegram's paper plane, filled, in Telegram's blue. */
export function TelegramLogo({ size = DEFAULT_SIZE, className }: ChannelLogoProps) {
  return (
    <TelegramLogoIcon
      size={size}
      weight="fill"
      color={TELEGRAM_BLUE}
      className={classes(className)}
      aria-hidden="true"
      data-channel-logo="telegram"
    />
  );
}

/** Slack's mark in the surrounding text colour. */
export function SlackLogo({ size = DEFAULT_SIZE, className }: ChannelLogoProps) {
  return (
    <SlackLogoIcon
      size={size}
      className={classes(className)}
      aria-hidden="true"
      data-channel-logo="slack"
    />
  );
}

/** Discord's mark, filled, in Discord's blue. */
export function DiscordLogo({ size = DEFAULT_SIZE, className }: ChannelLogoProps) {
  return (
    <DiscordLogoIcon
      size={size}
      weight="fill"
      color={DISCORD_BLURPLE}
      className={classes(className)}
      aria-hidden="true"
      data-channel-logo="discord"
    />
  );
}

/** A generic webhook: Phosphor's webhooks icon in the surrounding text colour. */
export function WebhookLogo({ size = DEFAULT_SIZE, className }: ChannelLogoProps) {
  return (
    <WebhooksLogoIcon
      size={size}
      className={classes(className)}
      aria-hidden="true"
      data-channel-logo="webhook"
    />
  );
}

/** The one logo each channel kind is shown with. */
export const CHANNEL_KIND_LOGOS: Record<ChannelKind, ComponentType<ChannelLogoProps>> = {
  telegram: TelegramLogo,
  slack: SlackLogo,
  discord: DiscordLogo,
  webhook: WebhookLogo,
};

export function ChannelKindLogo({ kind, ...props }: ChannelLogoProps & { kind: ChannelKind }) {
  const Logo = CHANNEL_KIND_LOGOS[kind];
  return <Logo {...props} />;
}
