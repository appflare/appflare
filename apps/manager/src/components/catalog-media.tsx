import { COVER_HEIGHT, COVER_WIDTH } from "@appflare/schema";
import { cn } from "@cloudflare/kumo";
import { monogram } from "../catalog/monogram";
import { CatalogImage } from "./catalog-image";

/**
 * Catalog images. Every `src` here is a manager path
 * (`/api/catalog/media/<sha256>` or `/api/catalog/avatar/<handle>`) that the
 * manager checked against the catalog index; nothing is loaded from another
 * origin. Kumo has no image, avatar or carousel component, so these are
 * plain elements styled with Kumo tokens, each in a box of fixed size
 * (`CatalogImage`) so nothing moves as images arrive.
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
  eager = false,
}: {
  src: string | null;
  /** The app's name, for the monogram. */
  name: string;
  size?: number;
  /** For an icon at the top of a page, which should not wait its turn to load. */
  eager?: boolean;
}) {
  if (src === null) return <Monogram name={name} size={size} />;
  return (
    <CatalogImage
      src={src}
      alt=""
      eager={eager}
      fallback={<Monogram name={name} size={size} />}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-lg ring ring-kumo-hairline"
    />
  );
}

/** An app's cover (the schema's cover size, 1200x630), full width. */
export function AppCover({
  src,
  alt,
  eager = false,
}: {
  src: string;
  alt: string;
  /** For a cover at the top of a page, which should not wait its turn to load. */
  eager?: boolean;
}) {
  return (
    <CatalogImage
      src={src}
      alt={alt}
      fit="cover"
      eager={eager}
      style={{ aspectRatio: `${COVER_WIDTH} / ${COVER_HEIGHT}` }}
      className="w-full rounded-lg ring ring-kumo-hairline"
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
  if (src === null) return <Monogram name={name} size={size} round />;
  return (
    <CatalogImage
      src={src}
      alt=""
      fit="cover"
      fallback={<Monogram name={name} size={size} round />}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-full ring ring-kumo-hairline"
    />
  );
}
