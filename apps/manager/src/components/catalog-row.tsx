import { Button, cn, Text } from "@cloudflare/kumo";
import { CaretLeftIcon, CaretRightIcon, type Icon } from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { showRowArrows, tileKeyTarget } from "../catalog/storefront";
import { AppTile, TILE_LINK_SELECTOR, TILE_WIDTH_REM, type TileApp } from "./catalog-tile";
import { useIsNarrow } from "./sidebar-rail";

/**
 * A row of app tiles on the catalog page: a heading with "See all" and,
 * when the tiles do not fit, previous and next arrows; the tiles scroll
 * sideways (14rem tiles, 1.5rem apart), snap to tile starts and hide the
 * native scrollbar (wheel, touch, the arrows and the keyboard still move
 * them). On a phone the arrows go and the row is swiped.
 */

/** Hidden native scrollbar; the row still scrolls by wheel, touch, keys and the arrows. */
const NO_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/**
 * Between tiles, in a row and in a grid: 1.5rem, so each tile reads as its
 * own unit even when its hover tint shows.
 */
const TILE_GAP_REM = 1.5;

/** A tile plus the gap; a page step keeps one tile of the last view as an anchor. */
const TILE_STEP_PX = (TILE_WIDTH_REM + TILE_GAP_REM) * 16;

interface ScrollEdges {
  atStart: boolean;
  atEnd: boolean;
}

/**
 * Whether a scroller is at its start and at its end, kept current on scroll,
 * resize, and when the number of tiles (`count`) changes.
 */
function useScrollEdges(scroller: RefObject<HTMLElement | null>, count: number): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ atStart: true, atEnd: true });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `count` re-measures when the tiles change, which the ResizeObserver on the scroller does not see
  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const measure = () =>
      setEdges({
        atStart: el.scrollLeft <= 1,
        atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
      });
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [scroller, count]);
  return edges;
}

/**
 * A previous or next arrow. At the row's end it is `aria-disabled` rather
 * than `disabled` and ignores the press: a disabled button drops keyboard
 * focus the moment the last page is reached.
 */
function ArrowButton({
  label,
  icon,
  controls,
  enabled,
  onPress,
}: {
  label: string;
  icon: Icon;
  controls: string;
  enabled: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant="ghost"
      shape="square"
      size="sm"
      icon={icon}
      aria-label={label}
      aria-controls={controls}
      aria-disabled={!enabled}
      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
      onClick={() => {
        if (enabled) onPress();
      }}
    />
  );
}

/** The row's heading: title and caption, "See all", and the arrows when they are shown. */
export function RowHeader({
  title,
  titleId,
  caption,
  onSeeAll,
  arrows,
  controls,
}: {
  title: string;
  titleId: string;
  caption: string | null;
  onSeeAll?: (() => void) | undefined;
  /** The arrows' state, or null when they are not shown. */
  arrows: { back: boolean; forward: boolean; onPage: (direction: 1 | -1) => void } | null;
  /** Id of the list the arrows scroll. */
  controls: string;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="grid min-w-0 gap-0.5">
        <Text as="h2" variant="heading" id={titleId}>
          {title}
        </Text>
        {caption !== null && (
          <Text as="span" variant="secondary" size="xs">
            {caption}
          </Text>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onSeeAll !== undefined && (
          <Button variant="ghost" size="sm" onClick={onSeeAll} aria-label={`See all: ${title}`}>
            See all
          </Button>
        )}
        {arrows !== null && (
          <>
            <ArrowButton
              label={`Previous apps in ${title}`}
              icon={CaretLeftIcon}
              controls={controls}
              enabled={arrows.back}
              onPress={() => arrows.onPage(-1)}
            />
            <ArrowButton
              label={`Next apps in ${title}`}
              icon={CaretRightIcon}
              controls={controls}
              enabled={arrows.forward}
              onPress={() => arrows.onPage(1)}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Left and Right move focus to the previous and next tile, Home and End to
 * the first and last; the browser scrolls the focused tile into view.
 */
function moveBetweenTiles(event: KeyboardEvent<HTMLUListElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const item = target.closest("li");
  if (item === null || item.parentElement !== event.currentTarget) return;
  const items = [...event.currentTarget.children];
  const next = tileKeyTarget(items.indexOf(item), event.key, items.length);
  if (next === null) return;
  event.preventDefault();
  items[next]?.querySelector<HTMLElement>(TILE_LINK_SELECTOR)?.focus();
}

export function AppRow({
  title,
  caption = null,
  apps,
  onSeeAll,
}: {
  title: string;
  caption?: string | null;
  apps: readonly TileApp[];
  onSeeAll?: () => void;
}) {
  const scroller = useRef<HTMLUListElement>(null);
  const edges = useScrollEdges(scroller, apps.length);
  const narrow = useIsNarrow();
  const titleId = useId();
  const listId = useId();
  const arrows = showRowArrows({ narrow, overflows: !(edges.atStart && edges.atEnd) });

  function page(direction: 1 | -1) {
    const el = scroller.current;
    if (el === null) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({
      left: direction * Math.max(el.clientWidth - TILE_STEP_PX, TILE_STEP_PX),
      behavior: reduce ? "auto" : "smooth",
    });
  }

  return (
    <section aria-labelledby={titleId} className="grid min-w-0 grid-cols-1 gap-1">
      <RowHeader
        title={title}
        titleId={titleId}
        caption={caption}
        onSeeAll={onSeeAll}
        controls={listId}
        arrows={arrows ? { back: !edges.atStart, forward: !edges.atEnd, onPage: page } : null}
      />
      <ul
        ref={scroller}
        id={listId}
        // biome-ignore lint/a11y/noRedundantRoles: list styles are removed, and Safari then drops the list role
        role="list"
        aria-labelledby={titleId}
        onKeyDown={moveBetweenTiles}
        className={cn(
          "relative -mx-3 flex snap-x snap-mandatory gap-6 overflow-x-auto py-1",
          NO_SCROLLBAR,
        )}
      >
        {apps.map((app) => (
          // w-56 is TILE_WIDTH_REM: every tile in a row is the same width.
          <li key={app.key} className="w-56 shrink-0 snap-start">
            <AppTile app={app} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The same tiles in a grid that fills the width, cells at least 14rem and
 * 1.5rem apart: the results of a search or filter, and "All apps".
 */
export function AppGrid({
  apps,
  labelledBy,
}: {
  apps: readonly TileApp[];
  /** Id of the heading that names the grid. */
  labelledBy: string;
}) {
  return (
    <ul
      // biome-ignore lint/a11y/noRedundantRoles: list styles are removed, and Safari then drops the list role
      role="list"
      aria-labelledby={labelledBy}
      className="-mx-3 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-6"
    >
      {apps.map((app) => (
        <li key={app.key} className="min-w-0">
          <AppTile app={app} />
        </li>
      ))}
    </ul>
  );
}

/** A section with a heading, for the results and the "All apps" list. */
export function CatalogSection({
  title,
  titleId,
  children,
}: {
  title: string;
  titleId: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={titleId} className="grid min-w-0 grid-cols-1 gap-2">
      <Text as="h2" variant="heading" id={titleId}>
        {title}
      </Text>
      {children}
    </section>
  );
}
