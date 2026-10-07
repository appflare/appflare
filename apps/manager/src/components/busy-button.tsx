import { AppflareLoader } from "@appflare/brand/loader";
import { Button } from "@cloudflare/kumo";
import type { ComponentProps } from "react";

type KumoButtonProps = ComponentProps<typeof Button>;
type KumoButtonSize = NonNullable<KumoButtonProps["size"]>;

/** `Omit` that keeps each member of a union (Kumo's props are a union on `shape`). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The mark's size in each Kumo button size: the size a Phosphor icon takes
 * there (1em of the button's text; Kumo's `text-base` is 14 px and
 * `text-xs` 12 px), so the mark fills the icon's slot and a button with an
 * icon keeps its width when it turns busy. Large buttons take 16 px, the
 * size Kumo's own loader has there.
 */
const MARK_PIXELS: Record<KumoButtonSize, number> = { xs: 12, sm: 12, base: 14, lg: 16 };

/**
 * The Appflare mark sized for a busy button's icon slot. It is hidden from
 * assistive technology: the button's `aria-busy` carries the state, and the
 * button's name stays its label instead of gaining "Loading".
 */
function BusyButtonMark({ size = "base" }: { size?: KumoButtonSize }) {
  return <AppflareLoader size={MARK_PIXELS[size]} aria-hidden />;
}

export type BusyButtonProps = DistributiveOmit<KumoButtonProps, "loading"> & {
  /** While true the button is disabled, marked `aria-busy`, and shows the Appflare mark in place of its icon. */
  pending?: boolean;
};

/**
 * Kumo's `Button` with a busy state drawn with the Appflare mark.
 *
 * Kumo's own `loading` prop always draws Kumo's spinner ring in the icon slot
 * and offers no way to swap it. This does what `loading` does with the mark
 * instead: the mark replaces the icon (or leads the label when there is
 * none), the label stays, and the button is disabled. It also sets
 * `aria-busy`, which `loading` does not.
 *
 * Kumo styles a `loading` button only through the variant's `disabled:`
 * classes, while its `disabled` prop adds a flat 50% opacity on top. A busy
 * button that is not otherwise disabled drops that extra fade, so it looks
 * the way Kumo's loading button looks.
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
      disabled
      aria-busy
      icon={<BusyButtonMark size={props.size} />}
      className={disabled ? className : `${className ?? ""} opacity-100`.trim()}
    />
  );
}

/**
 * The busy state for `LayerDialog.Actions.Primary`, which Kumo requires to be
 * the direct child of `LayerDialog.Actions` (so it cannot be wrapped) and
 * which takes no `icon` or `className`. Spread these props onto it and put
 * `<BusyMark pending={…} />` before its label:
 *
 * ```tsx
 * <LayerDialog.Actions.Primary type="submit" {...busyActionProps(pending)}>
 *   <BusyMark pending={pending} />
 *   Save
 * </LayerDialog.Actions.Primary>
 * ```
 *
 * The dialog's primary action is always a primary or destructive button,
 * whose variant already fades when disabled, so no opacity fix is needed.
 */
export function busyActionProps(
  pending: boolean,
  disabled = false,
): { disabled: boolean; "aria-busy": true | undefined } {
  return { disabled: pending || disabled, "aria-busy": pending || undefined };
}

/** The Appflare mark ahead of a dialog action's label while it is pending. */
export function BusyMark({ pending }: { pending: boolean }) {
  return pending ? <BusyButtonMark /> : null;
}
