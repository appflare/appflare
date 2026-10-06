import { Banner, Link, LinkButton } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { type ComponentProps, Fragment, type ReactNode } from "react";
import { messageSegments } from "./message-links";

/** What ends an address: a space, a quote, an angle bracket, a backtick, a closing bracket. */
const ADDRESS_END = "\\s\"'<>`)\\]}";

/**
 * A Cloudflare dashboard address: the scheme and host exactly (lower case),
 * then a path up to `ADDRESS_END`, or nothing. The host must end there: next
 * comes a slash, the end of the text, `ADDRESS_END`, or sentence punctuation
 * followed by one of those, so `dash.cloudflare.com.example.com`,
 * `dash.cloudflare.com:443` and `dash.cloudflare.com@example.com` stay text.
 * Greedy, with nothing after it to backtrack into, so a long line costs one
 * pass (the punctuation check only scans the run right after a host).
 */
const DASHBOARD_ADDRESS = new RegExp(
  `https://(?:one\\.)?dash\\.cloudflare\\.com(?=/|$|[${ADDRESS_END}]|[.,;:!?]+(?:$|[${ADDRESS_END}]))(?:/[^${ADDRESS_END}]*)?`,
  "g",
);

/** Punctuation that ends the sentence around an address rather than the address. */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

/**
 * The address without the punctuation at its end. A loop, not a pattern:
 * `/[.,;:!?]+$/` retries from every dot of a long run that does not end the
 * address, which is quadratic.
 */
function withoutTrailingPunctuation(address: string): string {
  let end = address.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(address.charAt(end - 1))) end--;
  return address.slice(0, end);
}

/**
 * The dashboard pages Appflare's own messages send people to, exactly as
 * `dashboardUrl` writes them (the account id, or `:account` when it is not
 * known yet), with their short labels.
 */
const SHORT_LABEL =
  /^https:\/\/dash\.cloudflare\.com\/\?to=\/(?:[0-9a-f]{32}|:account)\/(workers\/plans|r2\/overview)$/;
const SHORT_LABELS: Record<string, string> = {
  "workers/plans": "Workers plans",
  "r2/overview": "R2 in the dashboard",
};

/**
 * How a message shows its Cloudflare dashboard addresses: `full`, the
 * address itself as the link; `short`, a short label ("Workers plans") for
 * the pages in `SHORT_LABEL`, and the address itself for any other.
 */
export type DashboardLinks = "full" | "short";

type DashboardPart = { kind: "text"; text: string } | { kind: "address"; href: string };

/** The text as plain parts and dashboard addresses, in order. */
function dashboardParts(text: string): DashboardPart[] {
  const parts: DashboardPart[] = [];
  let last = 0;
  for (const match of text.matchAll(DASHBOARD_ADDRESS)) {
    const href = withoutTrailingPunctuation(match[0]);
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
    parts.push({ kind: "address", href });
    // The trimmed punctuation goes back to the text that follows.
    last = match.index + href.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** A dashboard address as a link that opens in a new tab. */
function DashboardLink({ href, mode }: { href: string; mode: DashboardLinks }) {
  const page = mode === "short" ? SHORT_LABEL.exec(href)?.[1] : undefined;
  const label = page === undefined ? undefined : SHORT_LABELS[page];
  return label !== undefined ? (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {label}
      <Link.ExternalIcon />
    </Link>
  ) : (
    // Kumo's link is an inline flex box; a long address wraps with the
    // sentence instead, breaking anywhere, the icon on its last line.
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline! break-all [&>.link-external-icon]:inline [&>.link-external-icon]:align-[-0.125em]"
    >
      {href}
      <Link.ExternalIcon />
    </Link>
  );
}

/** The text of a message with each Cloudflare dashboard address as an external link. */
function DashboardLinked({ text, mode }: { text: string; mode: DashboardLinks }) {
  return (
    <>
      {dashboardParts(text).map((part, i) =>
        part.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <Fragment key={i}>{part.text}</Fragment>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string
          <DashboardLink key={i} href={part.href} mode={mode} />
        ),
      )}
    </>
  );
}

/** Whether `MessageText` shows `message` with at least one link. */
export function messageHasLinks(message: string): boolean {
  return (
    messageSegments(message).some((s) => s.kind === "link") ||
    dashboardParts(message).some((p) => p.kind === "address")
  );
}

/**
 * A message string (a job error, a server error) with its links rendered as
 * Kumo links; see `message-links.ts`. `newTab` opens them in a new tab, for
 * messages shown while the admin is in the middle of something (a dialog, a
 * form, the setup wizard) that following the link would otherwise lose.
 *
 * A Cloudflare dashboard address (`dash.cloudflare.com`,
 * `one.dash.cloudflare.com`; no other site) is a link too, opening in a new
 * tab. By default its text is the whole address: a job error or a server
 * error can carry text from a build or from Cloudflare, and a short label
 * would hide where the address really goes. `dashboardLinks="short"` shows a
 * short label instead, only for sentences Appflare words itself, such as why
 * sandbox builds cannot be turned on (`sandbox/preflight.ts`).
 */
export function MessageText({
  message,
  newTab = false,
  dashboardLinks = "full",
}: {
  message: string;
  newTab?: boolean;
  dashboardLinks?: DashboardLinks;
}) {
  return (
    <>
      {messageSegments(message).map((segment, i) =>
        segment.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed string
          <Fragment key={i}>
            <DashboardLinked text={segment.text} mode={dashboardLinks} />
          </Fragment>
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
 * A banner for a message string. Kumo's banner title is plain text, so a
 * message with a link goes in the description instead.
 */
export function MessageBanner({
  message,
  variant,
  icon,
  newTab = false,
}: {
  message: string;
  variant: ComponentProps<typeof Banner>["variant"];
  icon: ReactNode;
  newTab?: boolean;
}) {
  return (
    <Banner
      variant={variant}
      icon={icon}
      {...(messageHasLinks(message)
        ? { description: <MessageText message={message} newTab={newTab} /> }
        : { title: message })}
    />
  );
}

/** An error banner for a message string (`MessageBanner`). */
export function ErrorMessageBanner({
  message,
  newTab = false,
}: {
  message: string;
  newTab?: boolean;
}) {
  return (
    <MessageBanner
      message={message}
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      newTab={newTab}
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
