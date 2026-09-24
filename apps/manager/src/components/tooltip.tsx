import { Tooltip as KumoTooltip } from "@cloudflare/kumo";
import type { ComponentProps, ReactNode } from "react";

/**
 * Kumo's tooltip popup is only bounded by the viewport, and its `className`
 * styles the trigger, not the popup. The cap therefore goes on the content:
 * at most 20rem wide, wrapping.
 */
export const TOOLTIP_CONTENT_CLASS = "block max-w-80 whitespace-normal text-pretty";

/** Tooltip content with the shared width cap; also for Kumo's `labelTooltip` on form fields. */
export function tooltipContent(content: ReactNode): ReactNode {
  return <span className={TOOLTIP_CONTENT_CLASS}>{content}</span>;
}

/** Kumo's Tooltip with the shared width cap. Use it for every tooltip in the manager. */
export function Tooltip({ content, ...props }: ComponentProps<typeof KumoTooltip>) {
  return <KumoTooltip {...props} content={tooltipContent(content)} />;
}
