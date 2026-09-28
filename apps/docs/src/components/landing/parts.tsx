import Link from "fumadocs-core/link";
import type { ReactNode } from "react";
import logoLight from "../../../../../docs/assets/logo_full.svg?url";
import logoDark from "../../../../../docs/assets/logo_full_white.svg?url";
import { siteName } from "../../lib/shared.ts";
import { DEPLOY_URL } from "../install/flow-panel.tsx";

/**
 * The small pieces of the front page: the logo, the two kinds of button and
 * the frame around a manager screenshot.
 */

/** The brand's orange, from the cloud in the logo. Used sparingly. */
const FLARE_BUTTON =
  "bg-[#fb6b00] text-white hover:bg-[#e46100] dark:bg-[#fb6b00] dark:hover:bg-[#ff7d1a]";

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

/** The Deploy to Cloudflare link, as a solid button in the brand's orange. */
export function DeployButton({ size = "md" }: { size?: "md" | "lg" }) {
  const sizing = size === "lg" ? "h-12 px-6 text-base" : "h-10 px-4 text-sm";
  return (
    <a
      href={DEPLOY_URL}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-semibold shadow-sm transition-colors ${FLARE_BUTTON} ${FOCUS_RING} ${sizing}`}
    >
      Deploy to Cloudflare
    </a>
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
