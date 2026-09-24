import { cn, Text, Tooltip } from "@cloudflare/kumo";
import { CubeIcon, DownloadSimpleIcon, StarIcon } from "@phosphor-icons/react";
import type { AppMediaView } from "../catalog/media";
import { type AppPopularity, formatCount } from "../catalog/popularity";

/**
 * Catalog images. Every `src` here is a manager path
 * (`/api/catalog/media/<sha256>`) that the manager checked against the
 * catalog index; nothing is loaded from another origin. Kumo has no image
 * component, so these are plain `img` elements styled with Kumo tokens.
 */

/** An app's square icon, or a neutral placeholder when the catalog has none. */
export function AppIcon({ src, size = 40 }: { src: string | null; size?: number }) {
  const box = { width: size, height: size };
  if (src === null) {
    return (
      <span
        aria-hidden
        style={box}
        className="flex shrink-0 items-center justify-center rounded-lg bg-kumo-recessed text-kumo-subtle"
      >
        <CubeIcon size={Math.round(size * 0.55)} />
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      style={box}
      className="shrink-0 rounded-lg bg-kumo-recessed object-contain ring ring-kumo-hairline"
      loading="lazy"
      decoding="async"
    />
  );
}

/** An app's 1200x630 cover, full width. */
export function AppCover({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      width={1200}
      height={630}
      className="aspect-[1200/630] h-auto w-full rounded-lg bg-kumo-recessed object-cover ring ring-kumo-hairline"
      decoding="async"
    />
  );
}

/** Screenshots in a responsive grid; each opens full size in a new tab. */
export function Screenshots({ items }: { items: AppMediaView["screenshots"] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((shot) => (
        <a
          key={shot.src}
          href={shot.src}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-lg ring ring-kumo-hairline"
        >
          <img
            src={shot.src}
            alt={shot.alt}
            className="h-auto w-full bg-kumo-recessed object-contain"
            loading="lazy"
            decoding="async"
          />
        </a>
      ))}
    </div>
  );
}

/**
 * Stars and, when the catalog read them, install counts; counts the catalog
 * publishes as null (below 10) read "Fewer than 10". Renders nothing when
 * there are no numbers to show.
 */
export function PopularityLine({
  popularity,
  className,
}: {
  popularity: AppPopularity | null;
  className?: string;
}) {
  if (popularity === null) return null;
  const { stars, activeInstalls, installs30d, installsKnown } = popularity;
  const installs = activeInstalls ?? installs30d;
  if (stars === null && !installsKnown) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-4 gap-y-1", className)}>
      {stars !== null && (
        <Tooltip content="Stars of the upstream repository on GitHub">
          <Text as="span" variant="secondary" size="sm">
            <span className="inline-flex items-center gap-1">
              <StarIcon aria-hidden weight="fill" />
              {formatCount(stars)}
              <span className="sr-only"> GitHub stars</span>
            </span>
          </Text>
        </Tooltip>
      )}
      {installs !== null && (
        <Tooltip
          content={
            activeInstalls !== null
              ? "Appflare managers running this app, from anonymous usage data"
              : "Appflare managers that installed this app in the last 30 days, from anonymous usage data"
          }
        >
          <Text as="span" variant="secondary" size="sm">
            <span className="inline-flex items-center gap-1">
              <DownloadSimpleIcon aria-hidden />
              {formatCount(installs)}
              <span className="sr-only">
                {activeInstalls !== null ? " active installs" : " installs in 30 days"}
              </span>
            </span>
          </Text>
        </Tooltip>
      )}
      {installs === null && installsKnown && (
        <Tooltip content="Appflare managers running this app, from anonymous usage data; counts below 10 are not published">
          <Text as="span" variant="secondary" size="sm">
            <span className="inline-flex items-center gap-1">
              <DownloadSimpleIcon aria-hidden />
              Fewer than 10<span className="sr-only"> installs</span>
            </span>
          </Text>
        </Tooltip>
      )}
    </span>
  );
}
