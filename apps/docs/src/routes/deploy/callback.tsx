import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CallbackPanel } from "../../components/deploy/callback-panel.tsx";
import { useFocusOnStepChange } from "../../components/deploy/deploy-panel.tsx";
import { DeployLayout } from "../../components/deploy/deploy-shell.tsx";
import { arrivedCallbackParams, forgetCallbackParams } from "../../deploy/arrival.ts";
import { type CallbackView, runCallback, submitReturn } from "../../deploy/callback.ts";
import { CALLBACK_PATH } from "../../deploy/config.ts";
import { requireDeployDocument } from "../../deploy/route-guard.ts";
import { browserDeployStorage } from "../../deploy/storage.ts";
import { TokenKeeper } from "../../deploy/tokens.ts";
import { noindexPageHead } from "../../lib/meta.ts";
import { ogImagePath, SITE_URL, siteName } from "../../lib/shared.ts";
import deployCss from "../../styles/deploy.css?url";

/**
 * `/deploy/callback`: where Cloudflare sends the browser back after
 * consent, with `code` and `state` in the query. They were taken out of the
 * address bar before the app started (`deploy/arrival.ts`). A deploy sign-in
 * is finished here and the tab returns to `/deploy/`; a manager's Reconnect
 * Cloudflare goes back to that manager as a form POST once the visitor
 * confirms its address.
 */
export const Route = createFileRoute("/deploy/callback")({
  beforeLoad: () => requireDeployDocument("/deploy/callback/"),
  head: () => {
    const head = noindexPageHead({
      title: `Connecting Cloudflare | ${siteName}`,
      description: "Finishing the Cloudflare sign-in for Appflare.",
      url: `${SITE_URL}${CALLBACK_PATH}`,
      image: `${SITE_URL}${ogImagePath([])}`,
    });
    return { ...head, links: [...head.links, { rel: "stylesheet", href: deployCss }] };
  },
  component: CallbackPage,
});

/** Runs once per page load, whatever React does with effects. */
let running: Promise<CallbackView> | null = null;

function callbackOnce(): Promise<CallbackView> {
  if (running === null) {
    const params = arrivedCallbackParams();
    forgetCallbackParams();
    const storage = browserDeployStorage();
    running = runCallback({
      params,
      storage,
      tokens: new TokenKeeper({ slot: storage.grant }),
      navigate: (url) => window.location.replace(url),
    });
  }
  return running;
}

function CallbackPage() {
  const [view, setView] = useState<CallbackView>({ step: "working" });
  useEffect(() => {
    let live = true;
    callbackOnce().then(
      (next) => {
        if (live) setView(next);
      },
      () => {
        if (live) {
          setView({ step: "problem", problem: { kind: "refused", retryable: true, code: "" } });
        }
      },
    );
    return () => {
      live = false;
    };
  }, []);
  const confirm = () => {
    if (view.step !== "confirm-return") return;
    setView({ step: "returning", origin: view.origin });
    submitReturn(document, view.origin, view.fields);
  };
  // Forgets the code: nothing is sent without the visitor's confirmation.
  const cancel = () => setView({ step: "cancelled" });
  useFocusOnStepChange(view.step);
  return (
    <DeployLayout aside={false}>
      <CallbackPanel view={view} onConfirm={confirm} onCancel={cancel} />
    </DeployLayout>
  );
}
