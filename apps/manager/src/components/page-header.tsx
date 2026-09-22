import { Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/** Page title, optional one-line description, and trailing actions. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="grid gap-1">
        <Text variant="heading" size="lg" as="h1">
          {title}
        </Text>
        {description !== undefined && <Text variant="secondary">{description}</Text>}
      </div>
      {actions}
    </header>
  );
}
