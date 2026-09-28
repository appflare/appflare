import { Banner, cn, Empty, LayerCard, Text } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Children, type ComponentProps, type ReactElement, type ReactNode, useId } from "react";
import { ErrorMessageBanner } from "./message-text";
import { ResponsiveTable } from "./responsive-table";

/**
 * One section of a page, the same everywhere: one layered Kumo `LayerCard`.
 *
 * - Its grey top band (`LayerCard.Secondary`) is the header: the
 *   sentence-case heading (with an optional docs link and a state badge
 *   beside it), one line of explanation under it, and at most one primary
 *   action on the right (under the text on phones).
 * - Its body (`LayerCard.Primary`) holds the content, never a card inside
 *   it. An error shows as a `Banner` at the top of the body; `empty` (a
 *   {@link SectionEmpty}, usually offering the section's action) replaces
 *   the content when there is nothing to list. A section with no content,
 *   error or empty state is the band alone.
 *
 * The content is one of the layouts below, each with its own padding (the
 * body adds none): {@link SectionBody} for free text and forms (with
 * {@link SectionFormActions} at the bottom right), {@link SectionRows} of
 * {@link SectionRow}s split by dividers, or a Kumo `Table` inside
 * {@link SectionTable}, flush with the body's edges. The `id` is the
 * section's link target (see `settings-links.ts`); `scroll-mt` keeps its
 * top clear of the page's top when a link scrolls to it.
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
  className,
  children,
}: {
  /** The section's link target; without one the section is not a link target. */
  id?: string;
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
  /** Merged over the section's own classes, such as how a link's ring sits around it. */
  className?: string;
  children?: ReactNode;
}) {
  const hasError = error !== undefined && error !== null && error !== "";
  const hasEmpty = empty !== undefined && empty !== null && empty !== false;
  const hasBody = hasError || hasEmpty || Children.toArray(children).length > 0;
  const ownId = useId();
  const headingId = `${id ?? ownId}-heading`;
  return (
    // The card sits inside the section, so the ring of an arrival
    // (`hash-target.ts`) goes around the card instead of replacing its outline.
    <section id={id} aria-labelledby={headingId} className={cn("grid scroll-mt-6", className)}>
      <LayerCard className="min-w-0">
        {/* Kumo's band pulls itself 8 px up and under the body by default; here
            it keeps its place, with the body's 20 px sides. */}
        <LayerCard.Secondary className={SECTION_BAND}>
          {/* On phones the action goes under the text; from 640 px it stays at the
              right, beside a description of any length. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="grid min-w-0 gap-0.5 sm:flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="flex items-center gap-1">
                  <Text variant="heading" as="h2" id={headingId}>
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
        </LayerCard.Secondary>
        {hasBody && (
          // Kumo's padding and gap are dropped: every layout below brings its own.
          <LayerCard.Primary className={SECTION_BODY}>
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
            {hasEmpty ? <div className="px-5 py-4">{empty}</div> : children}
          </LayerCard.Primary>
        )}
      </LayerCard>
    </section>
  );
}

/** The band's classes over Kumo's own: see {@link Section}. */
const SECTION_BAND = "my-0 block px-5 py-3 font-normal";

/** The body's classes over Kumo's own: see {@link Section}. */
const SECTION_BODY = "block min-w-0 p-0";

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
  return (
    // The first and last columns sit 20 px in, in line with the section's heading.
    <div className="min-w-0 [&_tr>:first-child]:pl-5 [&_tr>:last-child]:pr-5">
      <ResponsiveTable {...props} card={false} />
    </div>
  );
}
