import { AppflareLoader } from "@appflare/brand/loader";
import { Button } from "@cloudflare/kumo/components/button";
import type { ComponentProps, MouseEvent } from "react";

/*
 * The manager's busy button (apps/manager/src/components/busy-button.tsx),
 * for the deploy pages, so a button that is working looks the same here as
 * in Appflare itself.
 */

type KumoButtonProps = ComponentProps<typeof Button>;
type KumoButtonSize = NonNullable<KumoButtonProps["size"]>;

/** `Omit` that keeps each member of a union (Kumo's props are a union on `shape`). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The mark's size in each button size: the size a Phosphor icon takes there. */
const MARK_PIXELS: Record<KumoButtonSize, number> = { xs: 12, sm: 12, base: 14, lg: 16 };

export type BusyButtonProps = DistributiveOmit<KumoButtonProps, "loading"> & {
  /**
   * While true the button ignores presses, is marked `aria-busy` and
   * `aria-disabled`, and shows the Appflare mark in place of its icon. It is
   * not `disabled`, so a keyboard user who pressed it keeps the focus on it.
   */
  pending?: boolean;
};

/**
 * Kumo's `Button` with a busy state drawn with the Appflare mark. The mark
 * is hidden from assistive technology: `aria-busy` carries the state, and
 * the button keeps its label. Unlike Kumo's own `loading`, which disables the
 * button (and so drops the focus to the page), a busy button stays focusable
 * and swallows presses, a submit included.
 */
export function BusyButton({
  pending = false,
  disabled,
  icon,
  className,
  ...props
}: BusyButtonProps) {
  if (!pending) return <Button {...props} disabled={disabled} icon={icon} className={className} />;
  return (
    <Button
      {...props}
      disabled={disabled}
      aria-disabled
      aria-busy
      onClick={(event: MouseEvent<HTMLButtonElement>) => event.preventDefault()}
      icon={<AppflareLoader size={MARK_PIXELS[props.size ?? "base"]} aria-hidden />}
      className={`${className ?? ""} cursor-progress`.trim()}
    />
  );
}
