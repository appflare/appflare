import { Button, cn, Text } from "@cloudflare/kumo";
import { CaretLeftIcon, CaretRightIcon, DownloadSimpleIcon, StarIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { monogram } from "../catalog/monogram";
import { type AppPopularity, formatCount } from "../catalog/popularity";
import { Tooltip } from "./tooltip";

/**
 * Catalog images. Every `src` here is a manager path
 * (`/api/catalog/media/<sha256>` or `/api/catalog/avatar/<handle>`) that the
 * manager checked against the catalog index; nothing is loaded from another
 * origin. Kumo has no image, avatar or carousel component, so these are
 * plain elements styled with Kumo tokens.
 */

/** Two letters from a name on a neutral square (or circle), where there is no image. */
function Monogram({ name, size, round }: { name: string; size: number; round?: boolean }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      className={cn(
        "flex shrink-0 select-none items-center justify-center bg-kumo-recessed font-semibold text-kumo-subtle ring ring-kumo-hairline",
        round ? "rounded-full" : "rounded-lg",
      )}
    >
      {monogram(name)}
    </span>
  );
}

/**
 * An app's square icon wherever an app is shown (catalog cards and pages,
 * the home list, an install's page). Without one, or when the image fails to
 * load (a catalog that dropped an icon the page still names), a monogram of
 * `name`: the catalog ships upstream icons only, never generated ones.
 */
export function AppIcon({
  src,
  name,
  size = 40,
}: {
  src: string | null;
  /** The app's name, for the monogram. */
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (src === null || failed === src) return <Monogram name={name} size={size} />;
  return (
    <img
      src={src}
      alt=""
      style={{ width: size, height: size }}
      className="shrink-0 rounded-lg bg-kumo-recessed object-contain ring ring-kumo-hairline"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(src)}
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

/** A person's avatar through the manager's proxy, or their monogram when there is none or it fails. */
export function AuthorAvatar({
  src,
  name,
  size = 32,
}: {
  src: string | null;
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (src === null || failed) return <Monogram name={name} size={size} round />;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-full bg-kumo-recessed object-cover ring ring-kumo-hairline"
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * The app's images one at a time, at most 20rem tall, with previous and next
 * buttons and "n of m"; each opens full size in a new tab. A plain region
 * with labelled slides (the WAI carousel pattern without auto-rotation), as
 * Kumo has no carousel.
 */
export function ImageCarousel({
  items,
  label,
}: {
  items: ReadonlyArray<{ src: string; alt: string }>;
  label: string;
}) {
  const [index, setIndex] = useState(0);
  const current = items[Math.min(index, items.length - 1)];
  if (current === undefined) return null;
  const position = `${Math.min(index, items.length - 1) + 1} of ${items.length}`;
  const step = (by: number) => setIndex((i) => (i + by + items.length) % items.length);
  return (
    <section aria-roledescription="carousel" aria-label={label} className="grid gap-3">
      <figure
        aria-roledescription="slide"
        aria-label={position}
        className="m-0 flex h-80 items-center justify-center overflow-hidden rounded-lg bg-kumo-recessed ring ring-kumo-hairline"
      >
        <a href={current.src} target="_blank" rel="noreferrer" className="flex h-full">
          <img
            key={current.src}
            src={current.src}
            alt={current.alt}
            className="h-full w-auto max-w-full object-contain"
            decoding="async"
          />
        </a>
      </figure>
      {items.length > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            shape="square"
            size="sm"
            icon={CaretLeftIcon}
            aria-label="Previous image"
            onClick={() => step(-1)}
          />
          <Text as="span" variant="secondary" size="sm">
            <span aria-live="polite">{position}</span>
          </Text>
          <Button
            variant="secondary"
            shape="square"
            size="sm"
            icon={CaretRightIcon}
            aria-label="Next image"
            onClick={() => step(1)}
          />
        </div>
      )}
    </section>
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
