import Link from "fumadocs-core/link";
import type { ReactNode } from "react";
import logoLight from "../../../../../docs/assets/logo_full.svg?url";
import logoDark from "../../../../../docs/assets/logo_full_white.svg?url";
import { installLink } from "../../lib/install-links.ts";

import { siteName } from "../../lib/shared.ts";

export { InstallButton } from "../install-appflare.tsx";

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

/** Cloudflare's Deploy button, the other way to install, as one quiet line. */
export function DeployButtonLine({ placement }: { placement: string }) {
  return (
    <p className="m-0 text-fd-muted-foreground text-sm">
      Or use{" "}
      <a
        href={installLink(placement, true)}
        data-link-id={placement}
        className="font-medium text-fd-foreground underline underline-offset-4"
      >
        Cloudflare's Deploy button
      </a>
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

/**
 * A manager screenshot in a window frame. The screenshots are light, so in
 * dark mode the frame keeps them on their own light surface.
 */
export function Shot({
  src,
  alt,
  width,
  height,
  className = "",
  imgClassName = "h-auto",
  eager = false,
  chrome = true,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
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
        alt={alt}
        width={width}
        height={height}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        className={`block w-full object-cover object-top ${imgClassName}`}
      />
    </figure>
  );
}
