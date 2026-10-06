import { AppflareLoader } from "@appflare/brand/loader";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Text } from "@cloudflare/kumo/components/text";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { CallbackView } from "../../deploy/callback.ts";
import { DEPLOY_PATH } from "../../deploy/config.ts";
import { DeployCard, More } from "./deploy-shell.tsx";

/** What the OAuth callback page shows while it works, and when it cannot go on. */

const WIDE = "w-full justify-center";
const TOUCH = "max-sm:h-11";

function Working({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3">
      <AppflareLoader size={20} aria-hidden />
      <Text variant="secondary">{label}</Text>
    </div>
  );
}

function StartAgain() {
  return (
    <LinkButton href={DEPLOY_PATH} variant="primary" className={`${WIDE} ${TOUCH}`}>
      Start again
    </LinkButton>
  );
}

function problemText(view: Extract<CallbackView, { step: "problem" }>): string {
  const { problem } = view;
  if (typeof problem === "string") {
    switch (problem) {
      case "invalid-state":
        return "This page was opened without a sign-in from Appflare, or with a damaged one.";
      case "unknown-session":
        return "This sign-in was started in another tab, or it was already used. Start again in this tab.";
      case "missing-code":
        return "Cloudflare sent you back without the sign-in.";
    }
  }
  switch (problem.kind) {
    case "refused":
      return problem.retryable
        ? "Cloudflare did not answer when this page finished signing in. Start again in a moment."
        : "Cloudflare did not accept the sign-in. It may have taken too long; start again.";
    case "no-refresh-token":
      return "Cloudflare did not grant lasting access, so your new Appflare could not stay connected. Start again and allow everything Appflare asks for.";
    case "missing-scopes":
      return `Cloudflare did not grant ${problem.missing.length === 1 ? "one of the permissions" : `${problem.missing.length} of the permissions`} Appflare needs. Start again and allow everything Appflare asks for.`;
  }
}

export interface CallbackPanelProps {
  view: CallbackView;
  /** Sends the reconnect back to the Appflare the visitor confirmed. */
  onConfirm?: () => void;
  onCancel?: () => void;
}

export function CallbackPanel({ view, onConfirm, onCancel }: CallbackPanelProps) {
  switch (view.step) {
    case "working":
    case "done":
      return (
        <DeployCard meter={null} title="Connecting Cloudflare">
          <Working label="Finishing the Cloudflare sign-in…" />
          <noscript>
            <Text variant="secondary">This page needs JavaScript.</Text>
          </noscript>
        </DeployCard>
      );
    case "confirm-return":
      return (
        <DeployCard
          meter={null}
          title="Return to your Appflare?"
          description="Continue only if this is your own Appflare's address. Whoever runs it gets access to your Cloudflare account."
        >
          <p className="rounded-lg bg-kumo-recessed px-3 py-2.5 font-mono text-[0.9em] [overflow-wrap:anywhere]">
            {view.origin}
          </p>
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            <Button variant="primary" className={`${WIDE} ${TOUCH} sm:w-auto`} onClick={onConfirm}>
              Return to my Appflare
            </Button>
            <Button
              variant="ghost"
              className={`${TOUCH} max-sm:w-full max-sm:justify-center`}
              onClick={onCancel}
            >
              Cancel
            </Button>
          </div>
        </DeployCard>
      );
    case "returning":
      return (
        <DeployCard meter={null} title="Returning to your Appflare">
          <Working label={`Opening ${view.origin}…`} />
          <Text variant="secondary" size="sm">
            It shows whether Cloudflare is connected.
          </Text>
        </DeployCard>
      );
    case "cancelled":
      return (
        <DeployCard
          meter={null}
          title="Nothing was sent"
          description="You can close this page. To connect Cloudflare to your Appflare, start again from its settings."
        />
      );
    case "declined":
      return (
        <DeployCard
          meter={null}
          title="Cloudflare was not connected"
          description="You did not allow access, so nothing was installed. Appflare needs every permission it asks for."
        >
          <StartAgain />
        </DeployCard>
      );
    case "problem":
      return (
        <DeployCard meter={null} title="The sign-in did not finish">
          <div role="alert">
            <Banner
              variant="error"
              icon={<WarningCircleIcon weight="fill" />}
              description={problemText(view)}
            />
          </div>
          {typeof view.problem !== "string" && view.problem.kind === "missing-scopes" && (
            <More summary="Which permissions">
              <ul className="grid list-disc gap-0.5 pl-5 font-mono text-[0.9em]" translate="no">
                {view.problem.missing.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
            </More>
          )}
          <StartAgain />
        </DeployCard>
      );
  }
}
