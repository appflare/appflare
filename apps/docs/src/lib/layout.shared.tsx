import type { BaseLayoutProps } from "@fumadocs/base-ui/layouts/shared";
import logoLight from "../../../../docs/assets/logo_full.svg?url";
import logoDark from "../../../../docs/assets/logo_full_white.svg?url";
import { repositoryUrl, siteName } from "./shared.ts";

/** Options every layout shares: the logo in the navigation bar and the GitHub link. */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <img src={logoLight} alt={siteName} className="h-5 w-auto dark:hidden" />
          <img src={logoDark} alt={siteName} className="hidden h-5 w-auto dark:block" />
        </>
      ),
    },
    githubUrl: repositoryUrl,
  };
}
