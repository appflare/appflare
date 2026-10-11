import Link from "fumadocs-core/link";
import { type ComponentProps, type ReactNode, useRef } from "react";
import logoLight from "../../../../../docs/assets/logo_full.svg?url";
import logoDark from "../../../../../docs/assets/logo_full_white.svg?url";
import { track } from "../../analytics/analytics.ts";
import { installLink } from "../../lib/install-links.ts";
import { landingLinks } from "../../lib/landing.ts";
import { siteName } from "../../lib/shared.ts";
import { Lightbox, lightboxOpener, useLightbox } from "../catalog/lightbox.tsx";
import { InstallLink } from "../in-app/open-in-browser.tsx";

export { InstallButton, InstallShareLine } from "../install-appflare.tsx";

/**
 * The small pieces of the front page: the logo, the buttons, the line for
 * Cloudflare's Deploy button and
 * the frame around a manager screenshot.
 */

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-fd-ring focus-visible:outline-offset-2";

export function Wordmark({ className = "h-6" }: { className?: string }) {
  return (
    <>
      <img src={logoLight} alt={siteName} className={`${className} w-auto dark:hidden`} />
      <img src={logoDark} alt={siteName} className={`${className} hidden w-auto dark:block`} />
    </>
  );
}

/**
 * Cloudflare's Deploy button, the other way to install, as one quiet line.
 * It signs in to Cloudflare too, so in an app's own browser it asks the
 * visitor to move to their browser first, as Install Appflare does, offering
 * the page about the button.
 */
export function DeployButtonLine({ placement }: { placement: string }) {
  return (
    <p className="m-0 text-fd-muted-foreground text-sm">
      Or use{" "}
      <InstallLink
        href={installLink(placement, true)}
        handoffPath={landingLinks.deployButton}
        shareTitle="Deploy Appflare with Cloudflare's button"
        data-link-id={placement}
        className="font-medium text-fd-foreground underline underline-offset-4"
      >
        Cloudflare's Deploy button
      </InstallLink>
      .
    </p>
  );
}

/** A quiet bordered link button, for the secondary action. */
export function GhostButton({
  href,
  size = "md",
  children,
}: {
  href: string;
  size?: "md" | "lg";
  children: ReactNode;
}) {
  const sizing = size === "lg" ? "h-12 px-6 text-base" : "h-10 px-4 text-sm";
  return (
    <Link
      href={href}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-fd-border bg-fd-background font-semibold transition-colors hover:bg-fd-accent ${FOCUS_RING} ${sizing}`}
    >
      {children}
    </Link>
  );
}

type ShotProps = ComponentProps<typeof Shot>;

/**
 * A manager screenshot in a window frame. The screenshots are light, so in
 * dark mode the frame keeps them on their own light surface.
 */
export function Shot({
  src,
  alt,
  width,
  height,
  srcSet,
  sizes,
  className = "",
  imgClassName = "h-auto",
  eager = false,
  chrome = true,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Smaller WebP copies of `src`, made during the build, and the width the image is shown at. */
  srcSet?: string;
  sizes?: string;
  className?: string;
  /** Sizing of the image itself, such as a fixed aspect ratio that crops the bottom. */
  imgClassName?: string;
  eager?: boolean;
  /** The window's title bar dots. */
  chrome?: boolean;
}) {
  return (
    <figure
      className={`m-0 overflow-hidden rounded-xl border border-black/10 bg-[#fafafa] shadow-black/5 shadow-xl dark:border-white/10 dark:shadow-black/40 ${className}`}
    >
      {chrome && (
        <div aria-hidden="true" className="flex gap-1.5 border-black/5 border-b px-3 py-2.5">
          <span className="size-2.5 rounded-full bg-black/10" />
          <span className="size-2.5 rounded-full bg-black/10" />
          <span className="size-2.5 rounded-full bg-black/10" />
        </div>
      )}
      <img
        src={src}
        srcSet={srcSet}
        sizes={sizes}
        alt={alt}
        width={width}
        height={height}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : undefined}
        decoding="async"
        className={`block w-full object-cover object-top ${imgClassName}`}
      />
    </figure>
  );
}

/**
 * A {@link Shot} that opens larger in the lightbox, as an app's screenshots
 * do, where it can be zoomed. It is a link to the image, so it opens without
 * JavaScript too.
 */
export function ZoomableShot({ title, ...shot }: ShotProps & { title: string }) {
  const [box, dispatch] = useLightbox(1);
  const link = useRef<HTMLAnchorElement>(null);
  return (
    <>
      <a
        ref={link}
        href={shot.src}
        {...lightboxOpener(() => {
          dispatch({ type: "open", index: 0 });
          track("screenshot_opened", { slug: null, index: 0 });
        })}
        className={`block cursor-zoom-in rounded-xl ${FOCUS_RING}`}
      >
        <Shot {...shot} />
        <span className="sr-only">Opens it larger.</span>
      </a>
      <Lightbox
        title={title}
        images={[{ url: shot.src, alt: shot.alt }]}
        state={box}
        dispatch={dispatch}
        returnFocus={() => link.current}
      />
    </>
  );
}
