import { buttonVariants } from "@fumadocs/base-ui/components/ui/button";
import { CircleNotchIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { CallbackView } from "../../deploy/callback.ts";
import { DEPLOY_PATH } from "../../deploy/config.ts";

/** What the OAuth callback page shows while it works, and when it cannot go on. */

const primary = buttonVariants({ variant: "primary", className: "px-4 py-2 text-sm" });
const secondary = buttonVariants({ variant: "secondary", className: "px-4 py-2 text-sm" });

function Title({ children }: { children: ReactNode }) {
  return <h2 className="font-semibold text-xl tracking-tight">{children}</h2>;
}

function Text({ children }: { children: ReactNode }) {
  return <p className="text-fd-muted-foreground leading-relaxed">{children}</p>;
}

function StartAgain() {
  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <a href={DEPLOY_PATH} className={primary}>
        Start again
      </a>
    </div>
  );
}

function problemText(view: Extract<CallbackView, { step: "problem" }>): string {
  const { problem } = view;
  if (typeof problem === "string") {
    switch (problem) {
      case "invalid-state":
        return "This page was opened without a sign-in from Appflare, or with one that is damaged.";
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
      return `Cloudflare did not grant ${problem.missing.length === 1 ? "one of the permissions" : `${problem.missing.length} of the permissions`} Appflare needs (${problem.missing.join(", ")}). Start again and allow everything Appflare asks for.`;
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
        <p className="flex items-center gap-2 text-fd-muted-foreground">
          <CircleNotchIcon
            aria-hidden="true"
            className="size-5 animate-spin motion-reduce:animate-none"
          />
          Finishing the Cloudflare sign-in…
          <noscript>This page needs JavaScript.</noscript>
        </p>
      );
    case "confirm-return":
      return (
        <div className="grid gap-4">
          <h2 className="grid gap-1 font-semibold text-xl tracking-tight">
            <span>Return to your Appflare at</span>
            <span className="break-all rounded-lg border border-fd-border bg-fd-secondary px-3 py-2 font-mono text-base">
              {view.origin}
            </span>
          </h2>
          <Text>
            Continue only if this is your own Appflare's address, because whoever runs it gets
            access to your Cloudflare account.
          </Text>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className={primary} onClick={onConfirm}>
              Return to my Appflare
            </button>
            <button type="button" className={secondary} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      );
    case "returning":
      return (
        <p className="flex items-center gap-2 text-fd-muted-foreground">
          <CircleNotchIcon
            aria-hidden="true"
            className="size-5 animate-spin motion-reduce:animate-none"
          />
          Opening your Appflare at {view.origin}. It shows whether Cloudflare is connected.
        </p>
      );
    case "cancelled":
      return (
        <div className="grid gap-3">
          <Title>Nothing was sent</Title>
          <Text>
            You can close this page. To connect Cloudflare to your Appflare, start again from its
            settings.
          </Text>
        </div>
      );
    case "declined":
      return (
        <div className="grid gap-3">
          <Title>Cloudflare was not connected</Title>
          <Text>
            You did not allow access, so nothing was installed. Appflare needs every permission it
            asks for.
          </Text>
          <StartAgain />
        </div>
      );
    case "problem":
      return (
        <div className="grid gap-3">
          <Title>The sign-in did not finish</Title>
          <Text>{problemText(view)}</Text>
          <StartAgain />
        </div>
      );
  }
}
