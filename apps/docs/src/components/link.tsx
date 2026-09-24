import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";

/** `/security/#access` as `{ to: "/security/", hash: "access" }`. */
export function splitHref(href: string): { to: string; hash?: string } {
  const index = href.indexOf("#");
  if (index === -1) return { to: href };
  return { to: href.slice(0, index), hash: href.slice(index + 1) };
}

/**
 * The link Fumadocs renders for internal hrefs. Fumadocs' own TanStack adapter
 * passes the whole href as `to`, so the router treats a heading anchor as part
 * of the path and, with trailing slashes on, appends a slash to the anchor.
 * Here the anchor goes to `hash` instead.
 */
export function DocsLink({
  href,
  prefetch = true,
  ...props
}: ComponentProps<"a"> & { prefetch?: boolean }) {
  if (href === undefined || href.startsWith("#")) return <a href={href} {...props} />;
  const { to, hash } = splitHref(href);
  return <Link to={to} hash={hash} preload={prefetch ? "intent" : false} {...props} />;
}
