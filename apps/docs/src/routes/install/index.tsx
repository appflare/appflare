import { createFileRoute } from "@tanstack/react-router";
import { installRepoPath } from "../../catalog/urls.ts";
import { FlowPanel } from "../../components/install/flow-panel.tsx";
import {
  InstallHeader,
  InstallShell,
  RepositoryIcon,
} from "../../components/install/install-shell.tsx";
import { useFlow } from "../../components/install/use-flow.ts";
import { startInstall } from "../../install/flow.ts";
import { catalogAppForRepo, repoRequestFromSearch } from "../../install/request.ts";
import { noindexPageHead } from "../../lib/meta.ts";
import { ogImagePath, siteName, siteUrl } from "../../lib/shared.ts";

/**
 * `/install/?repo=<owner>/<repo>`: an Install button for a GitHub
 * repository, which the visitor's Appflare builds in their own account.
 * The page is prerendered once, without the repository, which is read from
 * the address in the browser and checked there. When the catalog already
 * has an app built from that repository, the page offers it first.
 */
export const Route = createFileRoute("/install/")({
  loader: async () => {
    const { installDirectory } = await import("../../catalog/data.ts");
    return { apps: installDirectory() };
  },
  head: () =>
    noindexPageHead({
      title: `Install from GitHub | ${siteName}`,
      description: "Open a GitHub repository in your own Appflare, ready to build and install.",
      url: `${siteUrl}${installRepoPath}`,
      image: `${siteUrl}${ogImagePath(["apps"])}`,
    }),
  component: InstallRepositoryPage,
});

function InstallRepositoryPage() {
  const { apps } = Route.useLoaderData();
  const { state, dispatch, forwarding } = useFlow(
    { page: "install", request: null, catalogApp: null },
    (memory) => {
      const request = repoRequestFromSearch(window.location.search);
      const match = request?.kind === "repo" ? catalogAppForRepo(apps, request.repo) : undefined;
      return startInstall(
        request,
        match === undefined ? null : { slug: match.slug, name: match.name },
        memory,
      );
    },
  );
  const request = state.context.page === "install" ? state.context.request : null;
  const repo = request?.kind === "repo" ? request.repo : null;
  return (
    <InstallShell
      header={
        <InstallHeader
          icon={<RepositoryIcon />}
          title={repo === null ? "Install from GitHub" : `Install ${repo}`}
          lines={
            <p>
              Built from its GitHub repository in your own Cloudflare account. Needs the Workers
              Paid plan.
            </p>
          }
        />
      }
    >
      <FlowPanel state={state} dispatch={dispatch} apps={apps} forwarding={forwarding} />
    </InstallShell>
  );
}
