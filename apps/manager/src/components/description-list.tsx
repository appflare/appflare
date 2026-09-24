import { cn, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/**
 * Key-value rows: a label column sized to its longest label, and the values.
 * Kumo has no description list component, so this is a `dl` in Kumo's text
 * styles; every details card uses it, so their rows line up the same way.
 */
export function DescriptionList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2.5",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/** One row of a {@link DescriptionList}. */
export function DescriptionItem({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <Text as="dt" variant="secondary">
        {label}
      </Text>
      <dd className="min-w-0 text-base text-kumo-default">{children}</dd>
    </>
  );
}
