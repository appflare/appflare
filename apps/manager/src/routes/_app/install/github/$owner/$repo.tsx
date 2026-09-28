import { createFileRoute, redirect } from "@tanstack/react-router";
import { installLinkRepository } from "../../../../../catalog/install-intent";
import { InstallLinkProblem } from "../../../../../components/install-link-problem";

/**
 * `/install/github/<owner>/<repo>`: an install link for a GitHub repository
 * (an "Install with Appflare" badge). Signing in first keeps it
 * (`returnTo`). For an admin it opens the catalog page with "Install from a
 * repository" open and the repository filled in; nothing is built until the
 * admin confirms there. Members get the catalog page, as they would anyway.
 * Anything that is not a GitHub repository gets a plain page instead.
 */
export const Route = createFileRoute("/_app/install/github/$owner/$repo")({
  staticData: { title: "Install" },
  beforeLoad: ({ params, context }) => {
    const repository = installLinkRepository(params.owner, params.repo);
    if (repository === null) return;
    throw redirect({
      to: "/catalog",
      search: context.viewer.role === "admin" ? { repository } : {},
      replace: true,
    });
  },
  component: () => <InstallLinkProblem kind="repository" />,
});
