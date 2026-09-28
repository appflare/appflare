import { COVER_HEIGHT, COVER_WIDTH } from "@appflare/schema";
import { cn } from "@cloudflare/kumo";
import { useState } from "react";
import { monogram } from "../catalog/monogram";

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

/** An app's cover (the schema's cover size, 1200x630), full width. */
export function AppCover({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      width={COVER_WIDTH}
      height={COVER_HEIGHT}
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
