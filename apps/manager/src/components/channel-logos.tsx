// The single-icon entry Phosphor documents: tests that render these logos in
// workerd then load one icon instead of the whole set.
import { WebhooksLogoIcon } from "@phosphor-icons/react/dist/csr/WebhooksLogo";
import { type ComponentType, useId } from "react";
import type { ChannelKind } from "../notifications/channels";

/**
 * The logo of each notification channel kind, as inline SVG, so a channel is
 * recognised at a glance. Telegram, Slack and Discord are trademarks of their
 * respective companies; their logos appear here only to identify the service
 * a channel posts to. The generic webhook uses Phosphor's webhooks icon.
 *
 * Every logo is decorative (`aria-hidden`): the kind's name is always written
 * next to it. `size` is the width and height in pixels; a logo that is not
 * square keeps its proportions, centred.
 */

export interface ChannelLogoProps {
  size?: number;
  className?: string;
}

const DEFAULT_SIZE = 20;

/** The logo never shrinks in a flex row; extra classes follow. */
function classes(className: string | undefined): string {
  return className === undefined ? "shrink-0" : `shrink-0 ${className}`;
}

/** Telegram's paper plane on its blue circle, with the brand's gradient. */
export function TelegramLogo({ size = DEFAULT_SIZE, className }: ChannelLogoProps) {
  // The gradient is referenced by id; a per-instance id keeps two logos on one page apart.
  const gradient = `telegram-${useId()}`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      width={size}
      height={size}
      className={classes(className)}
      aria-hidden="true"
      data-channel-logo="telegram"
    >
      <defs>
        <linearGradient id={gradient} x1="50%" x2="50%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="#2AABEE" />
          <stop offset="100%" stopColor="#229ED9" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradient})`}
        d="m128 0C94.06 0 61.48 13.494 37.5 37.49A128.038 128.038 0 0 0 0 128c0 33.934 13.5 66.514 37.5 90.51C61.48 242.506 94.06 256 128 256s66.52-13.494 90.5-37.49c24-23.996 37.5-56.576 37.5-90.51 0-33.934-13.5-66.514-37.5-90.51C194.52 13.494 161.94 0 128 0Z"
      />
      <path
        fill="#FFF"
        d="m57.94 126.648c37.32-16.256 62.2-26.974 74.64-32.152 35.56-14.786 42.94-17.354 47.76-17.441 1.06-.017 3.42.245 4.96 1.49 1.28 1.05 1.64 2.47 1.82 3.467.16.996.38 3.266.2 5.038-1.92 20.24-10.26 69.356-14.5 92.026-1.78 9.592-5.32 12.808-8.74 13.122-7.44.684-13.08-4.912-20.28-9.63-11.26-7.386-17.62-11.982-28.56-19.188-12.64-8.328-4.44-12.906 2.76-20.386 1.88-1.958 34.64-31.748 35.26-34.45.08-.338.16-1.598-.6-2.262-.74-.666-1.84-.438-2.64-.258-1.14.256-19.12 12.152-54 35.686-5.1 3.508-9.72 5.218-13.88 5.128-4.56-.098-13.36-2.584-19.9-4.708-8-2.606-14.38-3.984-13.82-8.41.28-2.304 3.46-4.662 9.52-7.072Z"
      />
    </svg>
  );
}

/** Slack's four-colour mark. */
export function SlackLogo({ size = DEFAULT_SIZE, className }: ChannelLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 2447.6 2452.5"
      width={size}
      height={size}
      className={classes(className)}
      aria-hidden="true"
      data-channel-logo="slack"
    >
      <g clipRule="evenodd" fillRule="evenodd">
        <path
          fill="#36C5F0"
          d="m897.4 0c-135.3.1-244.8 109.9-244.7 245.2-.1 135.3 109.5 245.1 244.8 245.2h244.8v-245.1c.1-135.3-109.5-245.1-244.9-245.3.1 0 .1 0 0 0m0 654h-652.6c-135.3.1-244.9 109.9-244.8 245.2-.2 135.3 109.4 245.1 244.7 245.3h652.7c135.3-.1 244.9-109.9 244.8-245.2.1-135.4-109.5-245.2-244.8-245.3z"
        />
        <path
          fill="#2EB67D"
          d="m2447.6 899.2c.1-135.3-109.5-245.1-244.8-245.2-135.3.1-244.9 109.9-244.8 245.2v245.3h244.8c135.3-.1 244.9-109.9 244.8-245.3zm-652.7 0v-654c.1-135.2-109.4-245-244.7-245.2-135.3.1-244.9 109.9-244.8 245.2v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.3z"
        />
        <path
          fill="#ECB22E"
          d="m1550.1 2452.5c135.3-.1 244.9-109.9 244.8-245.2.1-135.3-109.5-245.1-244.8-245.2h-244.8v245.2c-.1 135.2 109.5 245 244.8 245.2zm0-654.1h652.7c135.3-.1 244.9-109.9 244.8-245.2.2-135.3-109.4-245.1-244.7-245.3h-652.7c-135.3.1-244.9 109.9-244.8 245.2-.1 135.4 109.4 245.2 244.7 245.3z"
        />
        <path
          fill="#E01E5A"
          d="m0 1553.2c-.1 135.3 109.5 245.1 244.8 245.2 135.3-.1 244.9-109.9 244.8-245.2v-245.2h-244.8c-135.3.1-244.9 109.9-244.8 245.2zm652.7 0v654c-.2 135.3 109.4 245.1 244.7 245.3 135.3-.1 244.9-109.9 244.8-245.2v-653.9c.2-135.3-109.4-245.1-244.7-245.3-135.4 0-244.9 109.8-244.8 245.1 0 0 0 .1 0 0"
        />
      </g>
    </svg>
  );
}

/** Discord's brand blue, the logo's colour unless a text colour class overrides it. */
export const DISCORD_BLURPLE = "#5865F2";

/**
 * Discord's single-colour mark. It is drawn in `currentColor`, which the
 * `color` attribute sets to Discord's blue; a text colour class on the logo
 * wins over that attribute, for the white or black variants the brand allows.
 */
export function DiscordLogo({ size = DEFAULT_SIZE, className }: ChannelLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 199"
      width={size}
      height={size}
      color={DISCORD_BLURPLE}
      className={classes(className)}
      aria-hidden="true"
      data-channel-logo="discord"
    >
      <path
        fill="currentColor"
        d="m216.856 16.597A208.502 208.502 0 0 0 164.042 0c-2.275 4.113-4.933 9.645-6.766 14.046-19.692-2.961-39.203-2.961-58.533 0-1.832-4.4-4.55-9.933-6.846-14.046a207.809 207.809 0 0 0-52.855 16.638C5.618 67.147-3.443 116.4 1.087 164.956c22.169 16.555 43.653 26.612 64.775 33.193A161.094 161.094 0 0 0 79.735 175.3a136.413 136.413 0 0 1-21.846-10.632 108.636 108.636 0 0 0 5.356-4.237c42.122 19.702 87.89 19.702 129.51 0a131.66 131.66 0 0 0 5.355 4.237 136.07 136.07 0 0 1-21.886 10.653c4.006 8.02 8.638 15.67 13.873 22.848 21.142-6.58 42.646-16.637 64.815-33.213 5.316-56.288-9.08-105.09-38.056-148.36ZM85.474 135.095c-12.645 0-23.015-11.805-23.015-26.18s10.149-26.2 23.015-26.2c12.867 0 23.236 11.804 23.015 26.2.02 14.375-10.148 26.18-23.015 26.18Zm85.051 0c-12.645 0-23.014-11.805-23.014-26.18s10.148-26.2 23.014-26.2c12.867 0 23.236 11.804 23.015 26.2 0 14.375-10.148 26.18-23.015 26.18Z"
      />
    </svg>
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
