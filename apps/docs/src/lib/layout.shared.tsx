import type { BaseLayoutProps, LinkItemType } from "@fumadocs/base-ui/layouts/shared";
import logoLight from "../../../../docs/assets/logo_full.svg?url";
import logoDark from "../../../../docs/assets/logo_full_white.svg?url";
import { repositoryUrl, siteName } from "./shared.ts";

/** The catalog's apps page, linked from every page. */
export const appsLink: LinkItemType = { text: "Apps", url: "/apps/", active: "nested-url" };

/** The documentation's home, linked from the catalog pages, which have no docs sidebar. */
export const docsLink: LinkItemType = { text: "Docs", url: "/", active: "url" };

/**
 * Options every layout shares: the logo in the navigation bar, the link to
 * the apps, the GitHub link, and the theme switch.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    links: [appsLink],
    nav: {
      title: (
        <>
          <img src={logoLight} alt={siteName} className="h-5 w-auto dark:hidden" />
          <img src={logoDark} alt={siteName} className="hidden h-5 w-auto dark:block" />
        </>
      ),
    },
    githubUrl: repositoryUrl,
    // Light, dark, and system rather than a two-way flip, so a reader can go back to following the system.
    themeSwitch: { mode: "light-dark-system" },
  };
}
