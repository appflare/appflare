import { createFileRoute } from "@tanstack/react-router";
import { DeployPanel, JourneyRail, NO_ACTIONS } from "../../components/deploy/deploy-panel.tsx";
import { DeployShell } from "../../components/deploy/deploy-shell.tsx";
import { useDeployFlow } from "../../components/deploy/use-deploy-flow.ts";
import { DEPLOY_PATH } from "../../deploy/config.ts";
import { requireDeployDocument } from "../../deploy/route-guard.ts";
import { pageHead } from "../../lib/meta.ts";
import { ogImagePath, SITE_URL, siteName } from "../../lib/shared.ts";

/**
 * `/deploy/`: installs Appflare into the visitor's Cloudflare account from
 * the browser. Prerendered in its loading step; everything else happens in
 * the browser (`deploy/flow.ts`).
 */
export const Route = createFileRoute("/deploy/")({
  beforeLoad: () => requireDeployDocument("/deploy/"),
  head: () =>
    pageHead({
      title: `Install Appflare | ${siteName}`,
      description:
        "Install Appflare into your own Cloudflare account from your browser: connect Cloudflare, choose the account and address, deploy.",
      url: `${SITE_URL}${DEPLOY_PATH}`,
      // No card of its own: the site's card.
      image: `${SITE_URL}${ogImagePath([])}`,
    }),
  component: DeployPage,
});

function DeployPage() {
  const { view, flow } = useDeployFlow();
  return (
    <DeployShell rail={<JourneyRail view={view} />}>
      {flow === null ? (
        <DeployPanel view={view} actions={NO_ACTIONS} canGoBack={false} />
      ) : (
        <DeployPanel view={view} actions={flow} canGoBack={flow.canGoBack()} />
      )}
    </DeployShell>
  );
}
