// The apps the permissions' reasons name, worked out from the catalog when the site is built.
import examples from "virtual:appflare-scope-examples";
import { createFileRoute } from "@tanstack/react-router";
import { DeployPanel, NO_ACTIONS, showsIntro } from "../../components/deploy/deploy-panel.tsx";
import { DeployLayout } from "../../components/deploy/deploy-shell.tsx";
import { useDeployFlow } from "../../components/deploy/use-deploy-flow.ts";
import { DEPLOY_PATH } from "../../deploy/config.ts";
import { requireDeployDocument } from "../../deploy/route-guard.ts";
import { pageHead } from "../../lib/meta.ts";
import { ogImagePath, SITE_URL, siteName } from "../../lib/shared.ts";
import deployCss from "../../styles/deploy.css?url";

/**
 * `/deploy/`: installs Appflare into the visitor's Cloudflare account from
 * the browser. Prerendered in its loading step; everything else happens in
 * the browser (`deploy/flow.ts`). Drawn with Kumo, like Appflare itself, from
 * a stylesheet only the deploy pages load.
 */
export const Route = createFileRoute("/deploy/")({
  beforeLoad: () => requireDeployDocument("/deploy/"),
  head: () => {
    const head = pageHead({
      title: `Install Appflare | ${siteName}`,
      description:
        "Install Appflare into your own Cloudflare account from your browser: connect Cloudflare, choose the account and address, deploy.",
      url: `${SITE_URL}${DEPLOY_PATH}`,
      // No card of its own: the site's card.
      image: `${SITE_URL}${ogImagePath([])}`,
    });
    return { ...head, links: [...head.links, { rel: "stylesheet", href: deployCss }] };
  },
  component: DeployPage,
});

function DeployPage() {
  const { view, flow } = useDeployFlow();
  return (
    // What the installer keeps and the other ways to install matter before
    // Cloudflare is connected; past that, the visitor has chosen this way.
    <DeployLayout aside={showsIntro(view)}>
      {flow === null ? (
        <DeployPanel view={view} actions={NO_ACTIONS} canGoBack={false} examples={examples} />
      ) : (
        <DeployPanel
          view={view}
          actions={flow}
          canGoBack={flow.canGoBack()}
          accountStep={flow.choosesAccount()}
          examples={examples}
        />
      )}
    </DeployLayout>
  );
}
