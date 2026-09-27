import { cn, LayerCard, Table } from "@cloudflare/kumo";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

/**
 * The narrowest a table may get before it scrolls sideways instead. Wide
 * enough that no column wraps into a word per line on a phone; narrower than
 * the page's content area on a desktop, so desktop layout is unchanged.
 */
const MIN_WIDTH_CLASSES = {
  sm: "min-w-[30rem]",
  md: "min-w-[40rem]",
  lg: "min-w-[48rem]",
} as const;

export type ResponsiveTableWidth = keyof typeof MIN_WIDTH_CLASSES;

/**
 * Pins the first cell of every row to the left edge while the rest scrolls
 * under it. Body cells take their row's background (Kumo's table rows set
 * `--kumo-table-row-bg`, striped rows included) so content does not show
 * through; header cells already have an opaque background. The separator line
 * shows only once something has scrolled under the column. It is an inset
 * shadow rather than a border: the table collapses borders, and a collapsed
 * border does not travel with a sticky cell.
 */
const STICKY_FIRST_COLUMN_CLASSES = cn(
  "[&_tr>:first-child]:sticky [&_tr>:first-child]:left-0",
  "[&_td:first-child]:z-1 [&_th:first-child]:z-2",
  "[&_td:first-child]:bg-(--kumo-table-row-bg)",
  "data-overflow-start:[&_tr>:first-child]:shadow-[inset_-1px_0_0_var(--color-kumo-line)]",
);

/** Width of the soft fade on an edge that has more table beyond it. */
const FADE = "1.5rem";

/**
 * The mask that fades out the edges with more table beyond them, so a phone
 * user sees there is more to swipe to. None when nothing is hidden. With a
 * pinned first column the left edge never fades; the column's separator marks
 * it instead.
 */
export function edgeFadeMask(edges: ScrollEdges, stickyFirstColumn: boolean): string | undefined {
  const start = edges.start && !stickyFirstColumn;
  if (!start && !edges.end) return undefined;
  const from = start ? `transparent, #000 ${FADE}` : "#000";
  const to = edges.end ? `#000 calc(100% - ${FADE}), transparent` : "#000";
  return `linear-gradient(to right, ${from}, ${to})`;
}

/** Whether content is hidden past the left (`start`) or right (`end`) edge. */
export interface ScrollEdges {
  start: boolean;
  end: boolean;
}

const NO_OVERFLOW: ScrollEdges = { start: false, end: false };

/** Reads which edges of a horizontal scroll container have content beyond them. */
export function scrollEdges(el: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): ScrollEdges {
  // One pixel of slack: fractional widths leave sub-pixel remainders.
  return {
    start: el.scrollLeft > 1,
    end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
  };
}

/** Tracks the scroll edges of `ref`, following scrolling and size changes of it and its content. */
function useScrollEdges(ref: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>(NO_OVERFLOW);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const update = () => {
      const next = scrollEdges(el);
      setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    if (el.firstElementChild !== null) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref]);
  return edges;
}

/**
 * A Kumo table in a card that scrolls sideways when the screen is narrower
 * than the table, instead of squeezing columns or overflowing the page. Edges
 * with more table beyond them fade out, and the first column can stay pinned
 * so each row stays identifiable while scrolling. On a screen wide enough for
 * the table nothing scrolls and it renders as a plain table in a card.
 *
 * Children are the table's `Table.Header` and `Table.Body`.
 */
export function ResponsiveTable({
  label,
  minWidth = "md",
  stickyFirstColumn = false,
  card = true,
  children,
}: {
  /** Names the scroll region for screen readers, such as "Users". */
  label: string;
  minWidth?: ResponsiveTableWidth;
  /** Pin the first column; for tables whose first column names the row. */
  stickyFirstColumn?: boolean;
  /** False inside a card that is already there, such as a settings section's. */
  card?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const edges = useScrollEdges(ref);
  const scrollable = edges.start || edges.end;
  const mask = edgeFadeMask(edges, stickyFirstColumn);
  const table = (
    // Focusable only while it scrolls, so keyboard users can scroll it too.
    <section
      ref={ref}
      aria-label={label}
      tabIndex={scrollable ? 0 : undefined}
      data-overflow-start={edges.start ? "" : undefined}
      className={cn(
        "overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-brand",
        stickyFirstColumn && STICKY_FIRST_COLUMN_CLASSES,
      )}
      style={mask === undefined ? undefined : { maskImage: mask, WebkitMaskImage: mask }}
    >
      <Table className={MIN_WIDTH_CLASSES[minWidth]}>{children}</Table>
    </section>
  );
  return card ? <LayerCard className="p-0">{table}</LayerCard> : table;
}
