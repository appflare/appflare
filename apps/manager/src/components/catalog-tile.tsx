import { cn, LinkButton, Text } from "@cloudflare/kumo";
import { StarIcon } from "@phosphor-icons/react";
import type { CatalogListItem } from "../catalog/catalog.functions";
import { formatCount } from "../catalog/popularity";
import { PLAN_WORDS, primaryAction } from "../catalog/storefront";
import { AppIcon } from "./catalog-media";
import { RouterAnchor } from "./router-anchor";
import { Tooltip } from "./tooltip";

/**
 * An app on the catalog page, as a vertical tile: the icon on top, the name
 * on one line, the pitch in at most two lines, then one line with the plan
 * and the GitHub stars on the left and the one action on the right. Only
 * what helps someone pick an app; provenance, license and the services it
 * uses are on the app's page.
 */

/** A tile's fixed width in a row (14rem); in a grid it is the narrowest a cell gets. */
export const TILE_WIDTH_REM = 14;

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
    // `overflow-hidden` rather than wrapping: the line never runs under the
    // action beside it, even in the narrowest tile.
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-kumo-subtle text-xs">
      {/* A button, so a keyboard can reach the tooltip too. */}
      <Tooltip
        content={plan.tooltip}
        render={
          <button
            type="button"
            // Inset: the line clips anything drawn outside it.
            className="cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset"
          />
        }
      >
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
 * One app as a tile: the width of its row slot or grid cell. The icon, name
 * and pitch link to the app's page; "Get" goes there too (where installing
 * starts), "Manage" to the install.
 *
 * The main link is a plain router anchor, not Kumo's `Link`: `Link` always
 * adds `inline-flex items-center`, which outranks the tile's own layout and
 * put the icon beside the text instead of above it.
 */
export function AppTile({ app, className }: { app: TileApp; className?: string }) {
  const action = primaryAction(app);
  return (
    <div
      className={cn(
        // `relative` keeps screen-reader-only text inside the tile, so a tile
        // scrolled out of its row cannot widen the page.
        "relative flex h-full min-w-0 flex-col gap-3 rounded-xl p-3 hover:bg-kumo-tint",
        className,
      )}
    >
      <RouterAnchor
        href={`/catalog/${app.key}`}
        data-tile-link=""
        className="grid min-w-0 gap-3 rounded-lg text-kumo-default outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
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
      </RouterAnchor>
      <div className="mt-auto flex min-w-0 items-center justify-between gap-2">
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
