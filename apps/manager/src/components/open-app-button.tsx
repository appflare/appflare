import { LinkButton } from "@cloudflare/kumo";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";

/**
 * "Open": the app at its primary address (`appAddress`), in a new tab. Used
 * on the home list, the app page and job pages; the Worker name next to it
 * stays plain text.
 */
export function OpenAppButton({
  href,
  label,
  size,
  variant = "secondary",
}: {
  href: string;
  /** What the UI calls the install (`installLabel`), for screen readers. */
  label: string;
  size?: "sm";
  variant?: "primary" | "secondary";
}) {
  return (
    <LinkButton
      href={href}
      external
      variant={variant}
      {...(size === undefined ? {} : { size })}
      icon={<ArrowSquareOutIcon />}
      aria-label={`Open ${label}`}
      title={`Open ${href.replace(/^https:\/\//, "")} in a new tab`}
    >
      Open
    </LinkButton>
  );
}
