import { Banner, Link, LinkButton } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Fragment } from "react";
import { messageSegments } from "./message-links";

/**
 * A message string (a job error, a server error) with its links rendered as
 * Kumo links; see `message-links.ts`. `newTab` opens them in a new tab, for
 * messages shown while the admin is in the middle of something (a dialog, a
 * form, the setup wizard) that following the link would otherwise lose.
 */
export function MessageText({ message, newTab = false }: { message: string; newTab?: boolean }) {
  return (
    <>
      {messageSegments(message).map((segment, i) =>
        segment.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed string
          <Fragment key={i}>{segment.text}</Fragment>
        ) : newTab ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed string
          <Link key={i} href={segment.href} target="_blank" rel="noopener">
            {segment.label}
          </Link>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed string
          <Link key={i} href={segment.href}>
            {segment.label}
          </Link>
        ),
      )}
    </>
  );
}

/**
 * An error banner for a message string. Kumo's banner title is plain text,
 * so a message with a link goes in the description instead.
 */
export function ErrorMessageBanner({
  message,
  newTab = false,
}: {
  message: string;
  newTab?: boolean;
}) {
  const linked = messageSegments(message).some((s) => s.kind === "link");
  return (
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      {...(linked
        ? { description: <MessageText message={message} newTab={newTab} /> }
        : { title: message })}
    />
  );
}

/**
 * The places a message links to, as secondary buttons ("Open the catalog
 * settings"), for components that only take plain text, such as Kumo's
 * empty state; nothing when the message has no link.
 */
export function MessageLinkButtons({ message }: { message: string }) {
  const links = messageSegments(message).filter((s) => s.kind === "link");
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {links.map((link) => (
        <LinkButton key={link.href} href={link.href} variant="secondary">
          Open {link.label}
        </LinkButton>
      ))}
    </div>
  );
}
