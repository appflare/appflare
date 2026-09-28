import { formatCount, PLAN_WORDS } from "@appflare/schema/catalog-display";
import Link from "fumadocs-core/link";
import type { ReactNode } from "react";
import type { SiteApp, SiteCategory, SiteFeatured } from "../../catalog/site-catalog.ts";
import type { StorefrontRow } from "../../catalog/storefront.ts";
import { appPath, categoryPath } from "../../catalog/urls.ts";

/**
 * The pieces of the apps page, laid out as Appflare's own catalog page: apps
 * as vertical tiles (icon, name, pitch, plan and stars), in rows that scroll
 * sideways or in a grid, and the categories as cards. Images load from the
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

/** One row of the apps page: its tiles scroll sideways, "See all" opens the whole list. */
export function AppRow({ row }: { row: StorefrontRow }) {
  return (
    <CatalogSection
      title={row.title}
      caption={row.caption}
      action={
        row.seeAll !== null && (
          <Link
            href={row.seeAll}
            className="relative shrink-0 font-medium text-fd-primary text-sm hover:underline"
          >
            See all<span className="sr-only"> {row.title} apps</span>
          </Link>
        )
      }
    >
      <ul className="m-0 flex list-none snap-x snap-mandatory gap-1 overflow-x-auto p-0 pb-2">
        {row.apps.map((app) => (
          <li key={app.slug} className="w-52 shrink-0 snap-start">
            <AppTile app={app} />
          </li>
        ))}
      </ul>
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
