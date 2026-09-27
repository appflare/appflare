import { Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/**
 * A titled part of a page that lays out its own body: a heading, an optional
 * one-line description, and trailing actions. Cards inside it do not repeat
 * its title. Settings pages use `Section`, which draws the one card itself.
 */
export function PageSection({
  id,
  title,
  titleAction,
  description,
  actions,
  children,
}: {
  id?: string;
  title: string;
  /** A small control right after the heading, such as a link to the docs. */
  titleAction?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const heading = (
    <Text variant="heading" as="h2">
      {title}
    </Text>
  );
  return (
    <section id={id} className="grid scroll-mt-6 gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          {titleAction === undefined ? (
            heading
          ) : (
            <div className="flex items-center gap-1">
              {heading}
              {titleAction}
            </div>
          )}
          {description !== undefined && <Text variant="secondary">{description}</Text>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
