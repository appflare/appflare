import type { BaseLayoutProps, LinkItemType } from "@fumadocs/base-ui/layouts/shared";
import Link from "fumadocs-core/link";
import type { ComponentProps, MouseEvent } from "react";
import logoLight from "../../../../docs/assets/logo_full.svg?url";
import logoDark from "../../../../docs/assets/logo_full_white.svg?url";
import { repositoryUrl, siteName } from "./shared.ts";

/** The catalog's apps page, linked from every page. */
export const appsLink: LinkItemType = { text: "Apps", url: "/apps/", active: "nested-url" };

/**
 * Where the documentation starts, linked from the pages that have no docs
 * sidebar: the front page and the catalog's pages. `/` is the front page.
 */
export const DOCS_HOME = "/start/overview/";

export const docsLink: LinkItemType = { text: "Docs", url: DOCS_HOME, active: "url" };

/**
 * The repository, as an icon in the navigation bar. Fumadocs' own `githubUrl`
 * draws its icon as an unnamed `role="img"`, which accessibility checks fail;
 * here the link carries the name and the icon is hidden from assistive tech.
 */
export const githubLink: LinkItemType = {
  type: "icon",
  url: repositoryUrl,
  text: "GitHub",
  label: "GitHub",
  external: true,
  icon: (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  ),
};

/**
 * Whether a click on the logo should take the front page back to its top
 * rather than follow the link: on the front page itself, where the link
 * would lead nowhere, and for a plain click (a modifier keeps the browser's
 * own meaning, such as a new tab).
 */
export function logoScrollsToTop(
  pathname: string,
  click: Pick<
    MouseEvent,
    "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented"
  >,
): boolean {
  return (
    pathname === "/" &&
    click.button === 0 &&
    !click.defaultPrevented &&
    !click.metaKey &&
    !click.ctrlKey &&
    !click.shiftKey &&
    !click.altKey
  );
}

/** The logo in the navigation bar: a link to the front page, or back to its top when already there. */
export function LogoLink({ onClick, ...props }: ComponentProps<"a">) {
  function scrollOnFrontPage(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (!logoScrollsToTop(window.location.pathname, event)) return;
    event.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }
  return (
    <Link {...props} onClick={scrollOnFrontPage}>
      <img src={logoLight} alt={siteName} className="h-5 w-auto dark:hidden" />
      <img src={logoDark} alt={siteName} className="hidden h-5 w-auto dark:block" />
    </Link>
  );
}

/**
 * Options every layout shares: the logo in the navigation bar, which leads
 * to the front page from every page (see {@link LogoLink}), the link to the
 * apps, the GitHub link, and the theme switch.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    links: [appsLink, githubLink],
    nav: {
      url: "/",
      // Fumadocs calls this with the link's address and classes.
      title: (props) => <LogoLink {...props} />,
    },
    // Light, dark, and system rather than a two-way flip, so a reader can go back to following the system.
    themeSwitch: { mode: "light-dark-system" },
  };
}
