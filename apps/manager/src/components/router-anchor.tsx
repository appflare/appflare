import type { LinkComponentProps } from "@cloudflare/kumo";
import { useRouter } from "@tanstack/react-router";
import { forwardRef, type MouseEvent } from "react";
import { isInternalPagePath } from "./internal-path";

/**
 * Bridges Kumo's `LinkProvider` (anchors with `href`) to TanStack Router, so Kumo
 * links and sidebar items navigate client-side. External links, anything that
 * is not plainly one of the manager's pages (`internal-path.ts`), new-tab
 * targets, and modified clicks keep the browser's default behaviour.
 */
export const RouterAnchor = forwardRef<HTMLAnchorElement, LinkComponentProps>(function RouterAnchor(
  { href, to, onClick, target, ...rest },
  ref,
) {
  const router = useRouter();
  const url = href ?? to;
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      url === undefined ||
      !isInternalPagePath(url) ||
      (target !== undefined && target !== "_self") ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    void router.navigate({ href: url });
  }
  return <a ref={ref} href={url} target={target} onClick={handleClick} {...rest} />;
});
