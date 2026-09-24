import { Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/**
 * A titled part of a page: a heading, an optional one-line description, and
 * trailing actions. Cards inside a section do not repeat its title.
 */
export function Section({
  id,
  title,
  description,
  actions,
  children,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="grid scroll-mt-6 gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <Text variant="heading" as="h2">
            {title}
          </Text>
          {description !== undefined && <Text variant="secondary">{description}</Text>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
