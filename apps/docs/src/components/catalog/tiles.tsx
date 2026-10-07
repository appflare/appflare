import { formatCount, PLAN_WORDS } from "@appflare/schema/catalog-display";
import { ScrollArea } from "@cloudflare/kumo/primitives/scroll-area";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import Link from "fumadocs-core/link";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import type { SiteApp, SiteCategory, SiteFeatured } from "../../catalog/site-catalog.ts";
import type { StorefrontRow } from "../../catalog/storefront.ts";
import { appPath, categoryPath } from "../../catalog/urls.ts";

/**
 * The pieces of the apps page, laid out as Appflare's own catalog page: apps
 * as vertical tiles (icon, name, pitch, plan and stars), in rows that page
 * sideways with arrows or in a grid, and the categories as cards. Images load from the
 * catalog's own site, lazily and at fixed sizes, so nothing moves as they
 * arrive.
 */

export function StarIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="currentColor"
      className={className}
    >
      <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
    </svg>
  );
}

/** An app's icon at a fixed size, or its first letter on a tile when the catalog has none. */
export function AppIcon({
  src,
  name,
  size,
  lazy = true,
}: {
  src: string | null;
  name: string;
  size: number;
  lazy?: boolean;
}) {
  const box = { width: size, height: size };
  if (src === null) {
    return (
      <span
        aria-hidden="true"
        style={{ ...box, fontSize: size * 0.45 }}
        className="flex shrink-0 items-center justify-center rounded-xl bg-fd-secondary font-semibold text-fd-muted-foreground"
      >
        {Array.from(name.trim())[0]?.toUpperCase() ?? "?"}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading={lazy ? "lazy" : "eager"}
      decoding="async"
      style={box}
      className="shrink-0 rounded-xl object-contain"
    />
  );
}

/** "Paid · ★ 647": the plan as one word (its full name in the tooltip) and the stars. */
export function TileMeta({ app }: { app: Pick<SiteApp, "plan" | "popularity"> }) {
  const plan = PLAN_WORDS[app.plan];
  // A count of zero says nothing worth the space.
  const stars = (app.popularity?.stars ?? 0) > 0 ? (app.popularity?.stars ?? null) : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-fd-muted-foreground text-xs">
      <span title={plan.tooltip}>
        {plan.word}
        <span className="sr-only"> ({plan.name} plan)</span>
      </span>
      {stars !== null && (
        <>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-0.5 tabular-nums">
            <StarIcon />
            {formatCount(stars)}
            <span className="sr-only"> stars on GitHub</span>
          </span>
        </>
      )}
    </span>
  );
}

/** One app as a tile, linked to its page. */
export function AppTile({ app }: { app: SiteApp }) {
  return (
    <Link
      href={appPath(app.slug)}
      className="relative flex h-full min-w-0 flex-col gap-3 rounded-xl p-3 text-fd-foreground outline-none transition-colors hover:bg-fd-accent focus-visible:ring-2 focus-visible:ring-fd-ring"
    >
      <AppIcon src={app.icon} name={app.name} size={64} />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate font-semibold">{app.name}</span>
        <span className="line-clamp-2 min-h-[2lh] break-words text-fd-muted-foreground text-sm">
          {app.pitch}
        </span>
      </span>
      <span className="mt-auto">
        <TileMeta app={app} />
      </span>
    </Link>
  );
}

/** A titled part of the page. */
export function CatalogSection({
  title,
  caption,
  action,
  children,
}: {
  title: string;
  caption?: string | null | undefined;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-2">
      <div className="flex items-end justify-between gap-4 px-1">
        <div className="grid gap-0.5">
          <h2 className="font-semibold text-lg">{title}</h2>
          {caption && <p className="text-fd-muted-foreground text-sm">{caption}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Apps in a grid, as many columns as fit. With `phoneLimit`, a phone shows
 * only that many; the rest stay in the page, hidden on small screens.
 */
export function AppGrid({ apps, phoneLimit }: { apps: readonly SiteApp[]; phoneLimit?: number }) {
  return (
    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-1 p-0">
      {apps.map((app, i) => (
        <li
          key={app.slug}
          className={`min-w-0 ${phoneLimit !== undefined && i >= phoneLimit ? "max-sm:hidden" : ""}`}
        >
          <AppTile app={app} />
        </li>
      ))}
    </ul>
  );
}

interface ScrollEdges {
  atStart: boolean;
  atEnd: boolean;
}

/** Whether a scroller is at its start and at its end, kept current on scroll and resize. */
function useScrollEdges(scroller: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ atStart: true, atEnd: true });
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
  }, [scroller]);
  return edges;
}

/** A tile (w-52) plus the gap (gap-1); a page step keeps one tile of the last view as an anchor. */
const TILE_STEP_PX = 13 * 16 + 4;

/**
 * A previous or next arrow. At the row's end it is `aria-disabled` rather
 * than `disabled` and ignores the press: a disabled button drops keyboard
 * focus the moment the last page is reached.
 */
function ArrowButton({
  label,
  direction,
  controls,
  enabled,
  onPress,
}: {
  label: string;
  direction: 1 | -1;
  controls: string;
  enabled: boolean;
  onPress: () => void;
}) {
  const Icon = direction === 1 ? CaretRightIcon : CaretLeftIcon;
  return (
    <button
      type="button"
      aria-label={label}
      aria-controls={controls}
      aria-disabled={!enabled}
      onClick={() => {
        if (enabled) onPress();
      }}
      className="inline-flex size-8 items-center justify-center rounded-md text-fd-foreground transition-colors hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent"
    >
      <Icon aria-hidden="true" size={16} weight="bold" />
    </button>
  );
}

/**
 * One row of the apps page: its tiles scroll sideways and snap to tile
 * starts, with a thin scrollbar that shows while the row is hovered or
 * scrolled (Base UI's scroll area, through Kumo). When the tiles do not fit,
 * previous and next arrows page through them; on a phone the arrows go and
 * the row is swiped. "See all" opens the whole list.
 */
export function AppRow({ row }: { row: StorefrontRow }) {
  const scroller = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(scroller);
  const listId = useId();
  const overflows = !(edges.atStart && edges.atEnd);

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
    <CatalogSection
      title={row.title}
      caption={row.caption}
      action={
        <div className="flex shrink-0 items-center gap-1">
          {row.seeAll !== null && (
            <Link
              href={row.seeAll}
              className="relative mr-1 shrink-0 font-medium text-fd-primary text-sm hover:underline"
            >
              See all<span className="sr-only"> {row.title} apps</span>
            </Link>
          )}
          {overflows && (
            <span className="flex items-center gap-1 max-sm:hidden">
              <ArrowButton
                label={`Previous apps in ${row.title}`}
                direction={-1}
                controls={listId}
                enabled={!edges.atStart}
                onPress={() => page(-1)}
              />
              <ArrowButton
                label={`Next apps in ${row.title}`}
                direction={1}
                controls={listId}
                enabled={!edges.atEnd}
                onPress={() => page(1)}
              />
            </span>
          )}
        </div>
      }
    >
      <ScrollArea.Root className="relative min-w-0">
        <ScrollArea.Viewport
          ref={scroller}
          id={listId}
          // Base UI makes the viewport focusable; the tiles are the tab stops.
          tabIndex={-1}
          className="snap-x snap-mandatory overscroll-x-contain pb-2"
        >
          <ul className="m-0 flex list-none gap-1 p-0">
            {row.apps.map((app) => (
              <li key={app.slug} className="w-52 shrink-0 snap-start">
                <AppTile app={app} />
              </li>
            ))}
          </ul>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar
          orientation="horizontal"
          className="flex h-1.5 touch-none select-none p-px opacity-0 transition-opacity duration-150 data-[hovering]:opacity-100 data-[scrolling]:opacity-100"
        >
          <ScrollArea.Thumb className="rounded-full bg-fd-border" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </CatalogSection>
  );
}

/** Every category as a card with its number of apps. */
export function CategoryCards({
  categories,
  current,
}: {
  categories: readonly SiteCategory[];
  current?: string;
}) {
  return (
    <nav aria-label="Categories">
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {categories.map((category) => {
          const active = category.id === current;
          return (
            <li key={category.id}>
              <Link
                href={categoryPath(category.id)}
                aria-current={active ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors ${
                  active
                    ? "border-fd-primary bg-fd-primary text-fd-primary-foreground"
                    : "border-fd-border bg-fd-card hover:bg-fd-accent"
                }`}
              >
                {category.label}
                <span
                  className={`tabular-nums ${active ? "opacity-80" : "text-fd-muted-foreground"}`}
                >
                  {category.count}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** `rel` for every link to sponsor content. */
const SPONSORED_REL = "sponsored noopener noreferrer";

/**
 * The catalog's sponsored item, as one quiet card among the rows. The
 * "Sponsored" label lives here, not in the catalog, so no catalog can remove it.
 */
export function FeaturedCard({ item, appName }: { item: SiteFeatured; appName: string | null }) {
  return (
    <aside
      aria-label="Sponsored"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-fd-border bg-fd-card px-4 py-3"
    >
      {item.image !== null && (
        <img
          src={item.image.url}
          alt={item.image.alt}
          width={120}
          height={63}
          loading="lazy"
          className="shrink-0 rounded-md max-sm:hidden"
        />
      )}
      <div className="grid min-w-0 flex-1 basis-64 gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="rounded-md bg-fd-secondary px-1.5 py-0.5 font-medium text-fd-muted-foreground text-xs">
            Sponsored
          </span>
          <span className="truncate font-semibold">{item.title}</span>
        </span>
        <p className="text-fd-muted-foreground text-sm">
          {item.text}{" "}
          <span className="whitespace-nowrap">
            By{" "}
            {item.sponsor.url === undefined ? (
              item.sponsor.name
            ) : (
              <a href={item.sponsor.url} rel={SPONSORED_REL} className="underline">
                {item.sponsor.name}
              </a>
            )}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.slug !== undefined && appName !== null && (
          <Link
            href={appPath(item.slug)}
            className="rounded-md border border-fd-border px-3 py-1.5 font-medium text-sm hover:bg-fd-accent"
          >
            View {appName}
          </Link>
        )}
        {item.link !== undefined && (
          <a
            href={item.link.url}
            rel={SPONSORED_REL}
            className="rounded-md border border-fd-border px-3 py-1.5 font-medium text-sm hover:bg-fd-accent"
          >
            {item.link.label}
          </a>
        )}
      </div>
    </aside>
  );
}
