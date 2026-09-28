import { createFileRoute, notFound } from "@tanstack/react-router";
import { appPath, installPath } from "../../catalog/urls.ts";
import { AppIcon } from "../../components/catalog/tiles.tsx";
import { FlowPanel } from "../../components/install/flow-panel.tsx";
import { InstallHeader, InstallShell } from "../../components/install/install-shell.tsx";
import { useFlow } from "../../components/install/use-flow.ts";
import { type FlowPage, startInstall } from "../../install/flow.ts";
import type { InstallRequest } from "../../install/request.ts";
import { noindexPageHead } from "../../lib/meta.ts";
import { ogImagePath, SITE_URL, siteName } from "../../lib/shared.ts";

/**
 * `/install/<slug>/`: an app's Install button, as other sites and READMEs
 * link to it. Prerendered for every app in the catalog (an unknown slug
 * gets the 404 page); in the browser it opens the app in the visitor's own
 * Appflare, or asks where that is.
 */
export const Route = createFileRoute("/install/$slug")({
  loader: async ({ params }) => {
    const { findApp, installApp } = await import("../../catalog/data.ts");
    const app = findApp(params.slug);
    if (!app) throw notFound();
    return { app: installApp(app), cover: app.cover };
  },
  head: ({ loaderData }) =>
    loaderData
      ? noindexPageHead({
          title: `Install ${loaderData.app.name} | ${siteName}`,
          description: loaderData.app.pitch,
          url: `${SITE_URL}${installPath(loaderData.app.slug)}`,
          // The app page's card, so a shared install link previews the app.
          image: loaderData.cover ?? `${SITE_URL}${ogImagePath(["apps", loaderData.app.slug])}`,
        })
      : {},
  component: InstallAppPage,
});

function InstallAppPage() {
  const { app } = Route.useLoaderData();
  const request: InstallRequest = { kind: "app", slug: app.slug };
  const context: FlowPage = { page: "install", request, catalogApp: null };
  const { state, dispatch, forwarding } = useFlow(context, (memory) =>
    startInstall(request, null, memory),
  );
  return (
    <InstallShell
      header={
        <InstallHeader
          icon={<AppIcon src={app.icon} name={app.name} size={64} lazy={false} />}
          title={`Install ${app.name}`}
          lines={
            <>
              <p>{app.pitch}</p>
              <p className="text-sm">
                <a href={appPath(app.slug)} className="underline underline-offset-2">
                  About {app.name}
                </a>
              </p>
            </>
          }
        />
      }
    >
      <FlowPanel state={state} dispatch={dispatch} apps={[app]} forwarding={forwarding} />
    </InstallShell>
  );
}
