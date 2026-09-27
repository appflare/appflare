import { cn, Link, LinkButton, Text } from "@cloudflare/kumo";
import { StarIcon } from "@phosphor-icons/react";
import type { CatalogListItem } from "../catalog/catalog.functions";
import { formatCount } from "../catalog/popularity";
import { PLAN_WORDS, primaryAction } from "../catalog/storefront";
import { AppIcon } from "./catalog-media";
import { Tooltip } from "./tooltip";

/**
 * An app on the catalog page. A tile shows only what helps someone pick an
 * app: its icon, name and pitch, then one line with the plan and the GitHub
 * stars on the left and the one action on the right. Provenance, license
 * and the services it uses are on the app's page.
 */

/** What a tile reads from a catalog app. */
export type TileApp = Pick<
  CatalogListItem,
  "key" | "name" | "pitch" | "plan" | "popularity" | "images" | "instances"
>;

/** A tile's main link (`data-tile-link`), which the arrow keys move between in a row. */
export const TILE_LINK_SELECTOR = "[data-tile-link]";

function Dot() {
  return (
    <span aria-hidden className="text-kumo-inactive">
      ·
    </span>
  );
}

/** "Paid · ★ 647": the plan as one word (its full name in the tooltip) and the stars, on one line. */
export function TileMeta({ app }: { app: Pick<TileApp, "plan" | "popularity"> }) {
  const plan = PLAN_WORDS[app.plan];
  const stars = app.popularity?.stars ?? null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-kumo-subtle text-xs">
      <Tooltip content={plan.tooltip} render={<span />}>
        {plan.word}
        <span className="sr-only"> ({plan.name} plan)</span>
      </Tooltip>
      {stars !== null && (
        <>
          <Dot />
          <span className="inline-flex items-center gap-0.5 tabular-nums">
            <StarIcon aria-hidden weight="fill" size={12} />
            {formatCount(stars)}
            <span className="sr-only"> stars on GitHub</span>
          </span>
        </>
      )}
    </span>
  );
}

/**
 * One app as a tile: 14rem wide in a row, filling its cell in a grid. The
 * icon, name and pitch link to the app's page; "Get" goes there too (where
 * installing starts), "Manage" to the install.
 */
export function AppTile({ app, className }: { app: TileApp; className?: string }) {
  const action = primaryAction(app);
  return (
    <div
      className={cn(
        // `relative` keeps screen-reader-only text inside the tile, so a tile
        // scrolled out of its row cannot widen the page.
        "relative flex h-full flex-col gap-3 rounded-xl p-3 hover:bg-kumo-tint",
        className,
      )}
    >
      <Link
        href={`/catalog/${app.key}`}
        variant="plain"
        data-tile-link=""
        className="grid gap-3 rounded-lg text-kumo-default outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
      >
        <AppIcon src={app.images.icon} name={app.name} size={64} />
        <span className="grid min-w-0 gap-0.5">
          <Text as="span" bold truncate>
            {app.name}
          </Text>
          <Text as="span" variant="secondary" size="sm">
            <span className="line-clamp-2 min-h-[2lh] break-words">{app.pitch}</span>
          </Text>
        </span>
      </Link>
      <div className="mt-auto flex items-center justify-between gap-2">
        <TileMeta app={app} />
        <LinkButton
          href={action.href}
          size="xs"
          variant={action.label === "Get" ? "primary" : "secondary"}
          aria-label={action.ariaLabel}
          className="shrink-0"
        >
          {action.label}
        </LinkButton>
      </div>
    </div>
  );
}

/** One app in the compact "All apps" list: icon, name and pitch, the whole entry a link to its page. */
export function CompactAppLink({
  app,
}: {
  app: Pick<TileApp, "key" | "name" | "pitch" | "images">;
}) {
  return (
    <Link
      href={`/catalog/${app.key}`}
      variant="plain"
      className="flex min-w-0 items-center gap-3 rounded-lg p-2 text-kumo-default outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-brand"
    >
      <AppIcon src={app.images.icon} name={app.name} size={40} />
      <span className="grid min-w-0">
        <Text as="span" bold truncate>
          {app.name}
        </Text>
        <Text as="span" variant="secondary" size="sm" truncate>
          {app.pitch}
        </Text>
      </span>
    </Link>
  );
}
