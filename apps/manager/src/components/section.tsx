import { Banner, cn, Empty, LayerCard, Text } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { ErrorMessageBanner } from "./message-text";
import { ResponsiveTable } from "./responsive-table";

/**
 * One section of a settings page, the same everywhere:
 *
 * - a header: the sentence-case heading (with an optional docs link and a
 *   state badge beside it), one line of explanation under it, and at most
 *   one primary action on the right;
 * - one Kumo `LayerCard` for the body, never a card inside it. An error
 *   shows as a `Banner` at the top of the card; `empty` (a
 *   {@link SectionEmpty}, usually offering the section's action) replaces
 *   the body when there is nothing to list.
 *
 * The body is one of the layouts below: {@link SectionBody} for free text
 * and forms (with {@link SectionFormActions} at the bottom right),
 * {@link SectionRows} of {@link SectionRow}s split by dividers, or a Kumo
 * `Table` inside {@link SectionTable}. The `id` is the section's link target
 * (see `settings-links.ts`); `scroll-mt` keeps its heading clear of the top
 * when a link scrolls to it.
 */
export function Section({
  id,
  title,
  titleAction,
  badge,
  description,
  action,
  error,
  empty,
  children,
}: {
  id: string;
  title: string;
  /** A small control right after the heading: the section's docs link. */
  titleAction?: ReactNode;
  /** The section's state, beside the heading ("On", "3 tokens"). */
  badge?: ReactNode;
  /** One line under the heading. */
  description?: ReactNode;
  /** The section's one primary action, such as "Add channel". */
  action?: ReactElement | null;
  /** Shown as an error banner at the top of the card. */
  error?: string | ReactNode | null;
  /** Shown instead of the body when set. */
  empty?: ReactNode;
  children?: ReactNode;
}) {
  const hasError = error !== undefined && error !== null && error !== "";
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="grid scroll-mt-6 gap-3">
      {/* On phones the action goes under the text; from 640 px it stays at the
          right, beside a description of any length. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid min-w-0 gap-1 sm:flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex items-center gap-1">
              <Text variant="heading" as="h2" id={`${id}-heading`}>
                {title}
              </Text>
              {titleAction}
            </span>
            {badge}
          </div>
          {description !== undefined && <Text variant="secondary">{description}</Text>}
        </div>
        {action !== undefined && action !== null && <div className="sm:shrink-0">{action}</div>}
      </div>
      <LayerCard className="min-w-0">
        {hasError && (
          <div className="px-5 pt-4 last:pb-4">
            {typeof error === "string" ? (
              <ErrorMessageBanner message={error} />
            ) : (
              <Banner
                variant="error"
                icon={<WarningCircleIcon weight="fill" />}
                description={error}
              />
            )}
          </div>
        )}
        {empty !== undefined && empty !== null && empty !== false ? (
          <div className="px-5 py-4">{empty}</div>
        ) : (
          children
        )}
      </LayerCard>
    </section>
  );
}

/**
 * Kumo's `Empty` inside a section's card: without its own border and fill,
 * which would draw a box inside the card.
 */
export function SectionEmpty(props: Omit<ComponentProps<typeof Empty>, "className">) {
  return <Empty {...props} className="border-0 bg-transparent" />;
}

/** A padded body: free text, details, a form. */
export function SectionBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid min-w-0 gap-4 px-5 py-4", className)}>{children}</div>;
}

/** The Save (and Cancel) of a form in a section, at the bottom right. */
export function SectionFormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2">{children}</div>;
}

/** Rows split by dividers. */
export function SectionRows({ children }: { children: ReactNode }) {
  return <div className="grid min-w-0 divide-y divide-kumo-hairline">{children}</div>;
}

/**
 * One row: its title (and a line under it), anything more below, and a
 * trailing secondary `Button` or `DropdownMenu`. `id` makes the row a link
 * target of its own.
 */
export function SectionRow({
  id,
  title,
  description,
  action,
  className,
  stackAction = false,
  children,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Merged over the row's own classes, such as `px-0` in a card with padding of its own. */
  className?: string;
  /**
   * Always put the action under the text, for a narrow list whose rows
   * would otherwise place it beside some texts and under others.
   */
  stackAction?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        "grid min-w-0 scroll-mt-6 gap-3 px-5 py-4",
        // Arriving at a row by its link rings it inside, clear of the dividers.
        "[&.ring-2]:ring-inset [&.ring-2]:ring-offset-0",
        className,
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-4 gap-y-2",
          stackAction && "flex-col items-start",
        )}
      >
        <div className="grid min-w-0 max-w-prose gap-1">
          <Text bold as="span">
            {title}
          </Text>
          {description !== undefined && <Text variant="secondary">{description}</Text>}
        </div>
        {action !== undefined && action !== null && (
          <div className="flex flex-wrap items-center gap-2">{action}</div>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * A table in a section: a `ResponsiveTable` (scrolls sideways on a narrow
 * screen instead of squeezing) drawn in the section's card rather than one of
 * its own. Children are the table's `Table.Header` and `Table.Body`.
 */
export function SectionTable(props: Omit<ComponentProps<typeof ResponsiveTable>, "card">) {
  return <ResponsiveTable {...props} card={false} />;
}
