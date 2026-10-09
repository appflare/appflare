import { createFileRoute } from "@tanstack/react-router";
import { myPath } from "../../catalog/urls.ts";
import { FlowPanel } from "../../components/install/flow-panel.tsx";
import { InstallShell } from "../../components/install/install-shell.tsx";
import { useFlow } from "../../components/install/use-flow.ts";
import { startMy } from "../../install/flow.ts";
import { noindexPageHead } from "../../lib/meta.ts";
import { SITE_URL, siteName, siteOgImagePath } from "../../lib/shared.ts";

/**
 * `/my/`: which Appflare this site's Install buttons open. An Appflare
 * links here with its address in the fragment (`#manager=<origin>`), which
 * browsers never send to a server; the page asks before remembering it,
 * then takes the fragment out of the address bar. The address is kept in
 * this browser only.
 */
export const Route = createFileRoute("/my/")({
  loader: async () => {
    const { installDirectory } = await import("../../catalog/data.ts");
    return { apps: installDirectory() };
  },
  head: () =>
    noindexPageHead({
      title: `Your Appflare | ${siteName}`,
      description: "Choose the Appflare that Install buttons on this site open.",
      url: `${SITE_URL}${myPath}`,
      // No card of its own: the site's card.
      image: `${SITE_URL}${siteOgImagePath}`,
    }),
  component: MyPage,
});

function MyPage() {
  const { apps } = Route.useLoaderData();
  const { state, dispatch } = useFlow({ page: "my" }, (memory) => {
    const { hash, pathname, search } = window.location;
    const first = startMy(hash, memory, new Date());
    // Out of the address bar, so it is not bookmarked, shared or kept in history.
    if (hash !== "") window.history.replaceState(window.history.state, "", pathname + search);
    return first;
  });
  return (
    <InstallShell
      header={
        <header className="grid gap-2">
          <h1 className="font-bold text-3xl tracking-tight">Your Appflare</h1>
          <p className="text-fd-muted-foreground text-lg">
            Install buttons on this site open apps in your own Appflare. This browser remembers its
            address; it is not sent anywhere.
          </p>
        </header>
      }
    >
      <FlowPanel state={state} dispatch={dispatch} apps={apps} />
    </InstallShell>
  );
}
