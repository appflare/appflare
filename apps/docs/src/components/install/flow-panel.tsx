import { buttonVariants } from "@fumadocs/base-ui/components/ui/button";
import { type FormEvent, type ReactNode, useId } from "react";
import { PRIVATE_CLASS } from "../../analytics/analytics.ts";
import { appsPath, installPath } from "../../catalog/urls.ts";
import { EXAMPLE_ADDRESS } from "../../install/address.ts";
import type { FlowAction, FlowState } from "../../install/flow.ts";
import { type InstallApp, installPagePath, requestLabel } from "../../install/request.ts";

/**
 * One step of an install page or of `/my/`, drawn from the state in
 * `install/flow.ts`. Nothing here decides anything: every click goes back
 * to the state module as an action.
 */

/** The Deploy to Cloudflare button's link, which deploys Appflare from the browser. */
export const DEPLOY_URL = "https://link.appflare.dev/deploy";
/** Cloudflare's own image for that button. */
export const DEPLOY_BUTTON_IMAGE = "https://deploy.workers.cloudflare.com/button";

const primary = buttonVariants({ variant: "primary", className: "px-4 py-2 text-sm" });
const secondary = buttonVariants({ variant: "secondary", className: "px-4 py-2 text-sm" });
const quiet = buttonVariants({ variant: "ghost", className: "px-3 py-2 text-sm" });
const textLink = "font-medium text-fd-primary underline underline-offset-2";

function Title({ children }: { children: ReactNode }) {
  return <h2 className="font-semibold text-xl tracking-tight">{children}</h2>;
}

function Text({ children }: { children: ReactNode }) {
  return <p className="text-fd-muted-foreground leading-relaxed">{children}</p>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 pt-1">{children}</div>;
}

/**
 * An address as the visitor should read it: whole, never cut. It is the
 * visitor's own, so analytics never record it (see `PRIVATE_CLASS`), as
 * with every link to it and the field it is typed into.
 */
function Origin({ origin }: { origin: string }) {
  return (
    <strong
      className={`${PRIVATE_CLASS} font-semibold text-fd-foreground [overflow-wrap:anywhere]`}
    >
      {origin}
    </strong>
  );
}

function CannotRememberNote() {
  return (
    <p className="rounded-lg border border-fd-border bg-fd-secondary px-3 py-2 text-fd-muted-foreground text-sm">
      This browser does not let this site remember your Appflare, so it asks for the address each
      time.
    </p>
  );
}

export interface FlowPanelProps {
  state: FlowState;
  dispatch: (action: FlowAction) => void;
  /** The catalog's apps, to name a saved app on `/my/`. */
  apps: ReadonlyArray<Pick<InstallApp, "slug" | "name">>;
  /** False when the visitor came back with the Back button: the opening step waits for a click. */
  forwarding?: boolean;
}

export function FlowPanel({ state, dispatch, apps, forwarding = true }: FlowPanelProps) {
  const { context, view, canRemember } = state;
  const onInstall = context.page === "install";
  const request = context.page === "install" ? context.request : null;
  const what = request === null ? "this app" : requestLabel(request, apps);

  switch (view.step) {
    case "loading":
      return (
        <div className="grid gap-3">
          <Text>Checking this link…</Text>
          <noscript>
            <p className="text-fd-muted-foreground">
              This page needs JavaScript to find your Appflare.
            </p>
          </noscript>
        </div>
      );

    case "invalid":
      return (
        <div className="grid gap-3">
          <Title>This link is not valid</Title>
          <Text>
            {onInstall
              ? "It does not name an app or a GitHub repository that Appflare can install."
              : "It does not carry the address of an Appflare."}
          </Text>
          <Actions>
            <a href={appsPath} className={primary}>
              Browse apps
            </a>
          </Actions>
        </div>
      );

    case "in-catalog":
      return (
        <div className="grid gap-3">
          <Title>{view.app.name} is in the Appflare catalog</Title>
          <Text>
            The catalog's version is packaged and checked for Appflare. Building it from the
            repository instead happens in your own Cloudflare account and needs the Workers Paid
            plan.
          </Text>
          <Actions>
            <a href={installPath(view.app.slug)} className={primary}>
              Install {view.app.name} from the catalog
            </a>
            <button
              type="button"
              className={secondary}
              onClick={() => dispatch({ type: "use-repository" })}
            >
              Build from the repository
            </button>
          </Actions>
        </div>
      );

    case "ask":
      return (
        <div className="grid gap-3">
          <Title>Do you have Appflare?</Title>
          <Text>
            Appflare installs apps into your own Cloudflare account. This page opens {what} in your
            Appflare, where you check it and confirm the install.
          </Text>
          {!canRemember && <CannotRememberNote />}
          <Actions>
            <button
              type="button"
              className={primary}
              onClick={() => dispatch({ type: "choose-enter" })}
            >
              Enter its address
            </button>
            <button
              type="button"
              className={secondary}
              onClick={() => dispatch({ type: "choose-get" })}
            >
              Get Appflare
            </button>
          </Actions>
        </div>
      );

    case "enter":
      return (
        <AddressForm
          value={view.value}
          error={view.error}
          canRemember={canRemember}
          onEdit={(value) => dispatch({ type: "edit", value })}
          onSubmit={() => dispatch({ type: "submit" })}
          onBack={() => dispatch({ type: "back" })}
          backLabel={onInstall ? "Back" : "Cancel"}
        />
      );

    case "remember":
      return (
        <div className="grid gap-3">
          <Title>
            Remember <Origin origin={view.origin} /> as your Appflare?
          </Title>
          <Text>
            Install buttons on this site will then open apps there. The address stays in this
            browser.
            {view.replaces !== null && (
              <>
                {" "}
                It replaces <Origin origin={view.replaces} />.
              </>
            )}
          </Text>
          <Actions>
            <button
              type="button"
              className={primary}
              onClick={() => dispatch({ type: "remember" })}
            >
              Remember
            </button>
            {onInstall && (
              <button
                type="button"
                className={secondary}
                onClick={() => dispatch({ type: "once" })}
              >
                Just this once
              </button>
            )}
            <button type="button" className={quiet} onClick={() => dispatch({ type: "back" })}>
              {onInstall ? "Back" : "Cancel"}
            </button>
          </Actions>
        </div>
      );

    case "get":
      return (
        <div className="grid gap-4">
          <Title>Get Appflare</Title>
          <Text>
            Appflare runs in your own Cloudflare account, on the free plan or Workers Paid. Install
            it one of these ways:
          </Text>
          <ol className="m-0 grid list-none gap-4 p-0">
            <li className="grid gap-2">
              <a
                href={DEPLOY_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="justify-self-start"
              >
                <img
                  src={DEPLOY_BUTTON_IMAGE}
                  alt="Deploy to Cloudflare"
                  width={184}
                  height={39}
                  className="block"
                />
              </a>
              <span className="text-fd-muted-foreground text-sm">
                Everything happens in your browser.{" "}
                <a href="/start/deploy-button/" className={textLink}>
                  How the button works
                </a>
              </span>
            </li>
            <li className="grid gap-2">
              <span className="text-sm">Or, from a terminal:</span>
              <code className="justify-self-start rounded-md border border-fd-border bg-fd-secondary px-3 py-1.5 font-mono text-sm">
                npx create-appflare
              </code>
              <span className="text-fd-muted-foreground text-sm">
                <a href="/start/install/" className={textLink}>
                  Other ways to install
                </a>
              </span>
            </li>
          </ol>
          <p className="leading-relaxed">
            When it is ready, open <strong>Your account › Use this Appflare on appflare.dev</strong>{" "}
            in your Appflare.{" "}
            {view.intentSaved
              ? `This browser keeps ${what} for 7 days, so you can continue installing it then.`
              : `This browser does not let this site keep ${what}, so come back to this link then.`}
          </p>
          <Actions>
            <button
              type="button"
              className={secondary}
              onClick={() => dispatch({ type: "choose-enter" })}
            >
              I have Appflare now
            </button>
            <button type="button" className={quiet} onClick={() => dispatch({ type: "back" })}>
              Back
            </button>
          </Actions>
        </div>
      );

    case "opening":
      return (
        <div className="grid gap-3">
          <p role="status" className="text-lg leading-relaxed">
            {forwarding ? "Opening in your Appflare at " : "Your Appflare is at "}
            <Origin origin={view.origin} />
            {forwarding ? "…" : "."}
          </p>
          <details className="text-fd-muted-foreground text-sm">
            <summary className="cursor-pointer select-none">Details</summary>
            <p className="pt-2">
              The page this opens:{" "}
              <a
                href={view.target}
                className={`${PRIVATE_CLASS} font-mono text-fd-primary underline [overflow-wrap:anywhere]`}
              >
                {view.target}
              </a>
            </p>
          </details>
          {!canRemember && <CannotRememberNote />}
          <Actions>
            {!forwarding && (
              <a href={view.target} className={`${PRIVATE_CLASS} ${primary}`}>
                Open in your Appflare
              </a>
            )}
            <button
              type="button"
              className={secondary}
              onClick={() => dispatch({ type: "change" })}
            >
              Change
            </button>
          </Actions>
        </div>
      );

    case "saved":
      return (
        <div className="grid gap-3">
          <Title>{view.justRemembered ? "Appflare remembered" : "Your Appflare"}</Title>
          <Text>
            Install buttons on this site open apps in your Appflare at{" "}
            <Origin origin={view.origin} />.
          </Text>
          <Actions>
            {view.intent !== null && (
              <a href={installPagePath(view.intent)} className={primary}>
                Continue installing {requestLabel(view.intent, apps)}
              </a>
            )}
            <button
              type="button"
              className={secondary}
              onClick={() => dispatch({ type: "change" })}
            >
              Use a different Appflare
            </button>
            <button type="button" className={quiet} onClick={() => dispatch({ type: "forget" })}>
              Forget this Appflare
            </button>
          </Actions>
        </div>
      );

    case "none":
      return (
        <div className="grid gap-3">
          <Title>{view.forgotten ? "Appflare forgotten" : "No Appflare remembered"}</Title>
          <Text>
            {view.forgotten ? "This browser no longer remembers an Appflare. " : ""}
            To open apps from this site in your Appflare, open{" "}
            <strong>Your account › Use this Appflare on appflare.dev</strong> in your Appflare, or
            enter its address here.
          </Text>
          {!canRemember && <CannotRememberNote />}
          <Actions>
            <button
              type="button"
              className={primary}
              onClick={() => dispatch({ type: "choose-enter" })}
            >
              Enter its address
            </button>
            <a href="/start/install/" className={secondary}>
              Get Appflare
            </a>
          </Actions>
        </div>
      );

    case "cannot-remember":
      return (
        <div className="grid gap-3">
          <Title>This browser cannot remember your Appflare</Title>
          <Text>
            It does not let this site keep <Origin origin={view.origin} />, so Install buttons on
            this site will ask for your Appflare's address each time.
          </Text>
          <Actions>
            <a href={appsPath} className={primary}>
              Browse apps
            </a>
            <button type="button" className={quiet} onClick={() => dispatch({ type: "back" })}>
              Back
            </button>
          </Actions>
        </div>
      );
  }
}

function AddressForm({
  value,
  error,
  canRemember,
  onEdit,
  onSubmit,
  onBack,
  backLabel,
}: {
  value: string;
  error: string | null;
  canRemember: boolean;
  onEdit: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  backLabel: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }
  return (
    <form className="grid gap-3" onSubmit={submit} noValidate>
      <Title>Your Appflare's address</Title>
      <div className="grid gap-1.5">
        <label htmlFor={id} className="font-medium text-sm">
          Address
        </label>
        <input
          id={id}
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: the field is the only thing on this step
          autoFocus
          value={value}
          placeholder={EXAMPLE_ADDRESS}
          aria-invalid={error !== null}
          aria-describedby={error === null ? hintId : `${errorId} ${hintId}`}
          onChange={(event) => onEdit(event.target.value)}
          className={`${PRIVATE_CLASS} h-11 w-full rounded-lg border border-fd-border bg-fd-background px-3 text-base outline-none placeholder:text-fd-muted-foreground focus-visible:ring-2 focus-visible:ring-fd-ring aria-invalid:border-red-500`}
        />
        {error !== null && (
          <p id={errorId} role="alert" className="text-red-600 text-sm dark:text-red-400">
            {error}
          </p>
        )}
        <p id={hintId} className="text-fd-muted-foreground text-sm">
          The address you open Appflare at, as your browser shows it.
        </p>
      </div>
      {!canRemember && <CannotRememberNote />}
      <Actions>
        <button type="submit" className={primary}>
          Continue
        </button>
        <button type="button" className={quiet} onClick={onBack}>
          {backLabel}
        </button>
      </Actions>
    </form>
  );
}
