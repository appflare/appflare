import { buttonVariants } from "@fumadocs/base-ui/components/ui/button";
import {
  ArrowSquareOutIcon,
  CheckIcon,
  CircleNotchIcon,
  ClockIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useId } from "react";
import { REQUESTED_SCOPES } from "../../deploy/authorize.ts";
import type {
  Active,
  AddressChoice,
  DeployView,
  HandoffProblem,
  Notice,
  Plan,
  RemovalTarget,
} from "../../deploy/flow.ts";
import { hostnameFor, workersDevAddress } from "../../deploy/flow.ts";
import type { Unfinished, Zone } from "../../deploy/installer-api.ts";
import { DEPLOY_PATH } from "../../deploy/paths.ts";
import { SITE_URL } from "../../lib/shared.ts";

/**
 * One step of the deploy page, drawn from the state in `deploy/flow.ts`.
 * Nothing here decides anything: every click is a call on {@link DeployActions}.
 */

/** What the page can ask the flow to do. `DeployFlow` is one. */
export interface DeployActions {
  connect(): void;
  reconnect(): void;
  chooseAccount(accountId: string): void;
  startNew(): void;
  continueMine(): void;
  editName(value: string): void;
  submitName(): void;
  chooseAddress(choice: AddressChoice): void;
  submitAddress(): void;
  refreshAddress(): void;
  retryRelease(): void;
  deploy(): void;
  checkNow(): void;
  retry(): void;
  openAtWorkersDev(): void;
  requestRemove(installationId: string): void;
  confirmRemove(): void;
  afterRemoval(): void;
  back(): void;
}

const nothing = () => {};

/** Actions that do nothing: for the prerendered page, before the flow runs. */
export const NO_ACTIONS: DeployActions = {
  connect: nothing,
  reconnect: nothing,
  chooseAccount: nothing,
  startNew: nothing,
  continueMine: nothing,
  editName: nothing,
  submitName: nothing,
  chooseAddress: nothing,
  submitAddress: nothing,
  refreshAddress: nothing,
  retryRelease: nothing,
  deploy: nothing,
  checkNow: nothing,
  retry: nothing,
  openAtWorkersDev: nothing,
  requestRemove: nothing,
  confirmRemove: nothing,
  afterRemoval: nothing,
  back: nothing,
};

/** The brand's orange, as on the front page's Deploy button. For the one action that moves forward. */
const FLARE =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-[#fb6b00] px-4 py-2 font-semibold text-sm text-white shadow-sm transition-colors hover:bg-[#e46100] focus-visible:outline-2 focus-visible:outline-fd-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-[#ff7d1a]";
const primary = buttonVariants({ variant: "primary", className: "px-4 py-2 text-sm" });
const secondary = buttonVariants({ variant: "secondary", className: "px-4 py-2 text-sm" });
const quiet = buttonVariants({ variant: "ghost", className: "px-3 py-2 text-sm" });
const danger =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 font-semibold text-sm text-white transition-colors hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-fd-ring focus-visible:outline-offset-2";
const field =
  "h-11 w-full rounded-lg border border-fd-border bg-fd-background px-3 text-base outline-none placeholder:text-fd-muted-foreground focus-visible:ring-2 focus-visible:ring-fd-ring aria-invalid:border-red-500";

function Title({ children }: { children: ReactNode }) {
  return <h2 className="font-semibold text-xl tracking-tight">{children}</h2>;
}

function Text({ children }: { children: ReactNode }) {
  return <p className="text-fd-muted-foreground leading-relaxed">{children}</p>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2 pt-1">{children}</div>;
}

/** A value the visitor should read whole: an address, a name. */
function Strong({ children }: { children: ReactNode }) {
  return (
    <strong className="font-semibold text-fd-foreground [overflow-wrap:anywhere]">
      {children}
    </strong>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-fd-muted-foreground">
      <CircleNotchIcon
        aria-hidden="true"
        className="size-5 animate-spin motion-reduce:animate-none"
      />
      {label}
    </p>
  );
}

function Callout({
  tone = "info",
  children,
}: {
  tone?: "info" | "warning" | "error";
  children: ReactNode;
}) {
  const tones = {
    info: "border-fd-border bg-fd-secondary text-fd-muted-foreground",
    warning:
      "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100",
    error:
      "border-red-300 bg-red-50 text-red-900 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-100",
  } as const;
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={`grid gap-2 rounded-lg border px-3 py-2.5 text-sm leading-relaxed ${tones[tone]}`}
    >
      {children}
    </div>
  );
}

function ErrorText({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-red-600 text-sm dark:text-red-400">
      {children}
    </p>
  );
}

function Details({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="text-fd-muted-foreground text-sm">
      <summary className="cursor-pointer select-none">{summary}</summary>
      <div className="grid gap-2 pt-2">{children}</div>
    </details>
  );
}

function BackButton({ actions, label = "Back" }: { actions: DeployActions; label?: string }) {
  return (
    <button type="button" className={quiet} onClick={() => actions.back()}>
      {label}
    </button>
  );
}

// --- The journey -------------------------------------------------------------

/** The stages a visitor goes through, in order. */
export const STAGES = [
  "Connect",
  "Account",
  "Name",
  "Address",
  "Review",
  "Deploy",
  "Set up",
] as const;
export type Stage = (typeof STAGES)[number];

/** Which stage a step belongs to; null for the steps outside the journey (removing). */
export function stageOf(view: DeployView): Stage | null {
  switch (view.step) {
    case "loading":
    case "unavailable":
    case "welcome":
      return "Connect";
    case "working":
    case "account":
    case "unfinished":
    case "error":
      return "Account";
    case "name":
      return "Name";
    case "address":
      return "Address";
    case "review":
      return "Review";
    case "deploying":
    case "deploy-failed":
    case "handing-off":
    case "handoff-failed":
      return "Deploy";
    case "opening":
    case "set-up":
      return "Set up";
    case "confirm-remove":
    case "removing":
    case "removed":
      return null;
  }
}

/** The stages as a short ordered list, the current one marked. */
export function JourneyRail({ view }: { view: DeployView }) {
  const stage = stageOf(view);
  if (stage === null) return null;
  const at = STAGES.indexOf(stage);
  return (
    <ol aria-label="Steps" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {STAGES.map((name, i) => (
        <li
          key={name}
          aria-current={i === at ? "step" : undefined}
          className={
            i === at
              ? "font-semibold text-fd-foreground"
              : i < at
                ? "text-fd-muted-foreground"
                : "text-fd-muted-foreground/60"
          }
        >
          <span className="tabular-nums">{i + 1}.</span> {name}
          {i < at && <span className="sr-only"> (done)</span>}
        </li>
      ))}
    </ol>
  );
}

// --- Steps -------------------------------------------------------------------

const NOTICES: Record<Notice, string> = {
  reconnect:
    "Your Cloudflare connection ran out. Connect again to carry on where you left off. Nothing was lost.",
  "finished-elsewhere":
    "The installation this browser remembered is finished or was removed, so there is nothing to continue.",
  "account-unreachable":
    "This Cloudflare login does not reach the account where you started installing Appflare. Connect with that login to continue it, or choose an account below to start again.",
};

function Welcome({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "welcome" }>;
  actions: DeployActions;
}) {
  return (
    <div className="grid gap-3">
      <Title>
        {view.unfinished ? "Continue installing Appflare" : "Connect your Cloudflare account"}
      </Title>
      {view.notice !== null && <Callout tone="warning">{NOTICES[view.notice]}</Callout>}
      {view.unfinished ? (
        <Text>
          This browser started installing Appflare. Connect Cloudflare to continue it, or to remove
          what it created.
        </Text>
      ) : (
        <Text>
          Cloudflare asks you to sign in and allow Appflare to manage your account. Then you choose
          where Appflare goes and check everything before anything is created.
        </Text>
      )}
      <Text>
        Appflare asks for every permission it uses at once, so it never has to ask again when you
        turn on a feature later. You cannot leave some out.
      </Text>
      <Details summary="The permissions Appflare asks for">
        <ul className="grid list-disc gap-0.5 pl-5 font-mono text-xs">
          {REQUESTED_SCOPES.map((scope) => (
            <li key={scope}>{scope}</li>
          ))}
          <li>offline_access</li>
        </ul>
        <p>
          Billing is not among them, so Appflare cannot read your Workers plan this way. It works
          the plan out from what your account can run, or asks you in its settings.
        </p>
      </Details>
      {view.error !== null && <ErrorText>{view.error}</ErrorText>}
      <Actions>
        <button
          type="button"
          className={FLARE}
          disabled={view.busy}
          onClick={() => actions.connect()}
        >
          {view.busy ? "Opening Cloudflare…" : "Connect Cloudflare"}
        </button>
      </Actions>
    </div>
  );
}

function Unavailable({ view }: { view: Extract<DeployView, { step: "unavailable" }> }) {
  const site = new URL(SITE_URL).host;
  return (
    <div className="grid gap-3">
      <Title>Connecting Cloudflare does not work here</Title>
      <Text>
        {view.reason === "unregistered-origin"
          ? `After you allow access, Cloudflare sends you back only to ${site}, so this copy of the page cannot sign in.`
          : "This copy of the page is set up to finish signing in at another address, so it cannot sign in here."}
      </Text>
      <Actions>
        <a href={`${SITE_URL}${DEPLOY_PATH}`} className={primary}>
          Open {site}
          {DEPLOY_PATH.replace(/\/$/, "")}
        </a>
      </Actions>
    </div>
  );
}

function AccountPicker({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "account" }>;
  actions: DeployActions;
}) {
  return (
    <div className="grid gap-3">
      <Title>Choose an account</Title>
      {view.notice !== null && (
        <Callout tone="warning">
          <p>{NOTICES[view.notice]}</p>
          {view.notice === "account-unreachable" && (
            <div>
              <button type="button" className={secondary} onClick={() => actions.reconnect()}>
                Connect with another login
              </button>
            </div>
          )}
        </Callout>
      )}
      <Text>
        Your Cloudflare login reaches more than one account. Appflare goes into one of them.
      </Text>
      <ul className="grid gap-2">
        {view.accounts.map((account) => (
          <li key={account.id}>
            <button
              type="button"
              onClick={() => actions.chooseAccount(account.id)}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-fd-border bg-fd-background px-4 py-3 text-left transition-colors hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-fd-ring"
            >
              <span className="font-medium [overflow-wrap:anywhere]">{account.name}</span>
              <span aria-hidden="true" className="text-fd-muted-foreground text-sm">
                Choose
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function progressLine(item: Pick<Unfinished, "done" | "total" | "step" | "status">): string {
  if (item.status === "deployed") return "Deployed, waiting to be connected";
  if (item.status === "removing") return "Being removed";
  return `Step ${Math.min(item.done + 1, item.total)} of ${item.total}: ${item.step.label}`;
}

function UnfinishedList({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "unfinished" }>;
  actions: DeployActions;
}) {
  const { mine, others } = view;
  return (
    <div className="grid gap-3">
      <Title>{mine !== null ? "Continue installing Appflare?" : "Unfinished installations"}</Title>
      {view.notice !== null && <Callout>{NOTICES[view.notice]}</Callout>}
      {view.error !== undefined && <Callout tone="error">{view.error}</Callout>}
      {mine !== null && (
        <div className="grid gap-2 rounded-lg border border-fd-border p-4">
          <p>
            <Strong>{mine.address}</Strong>
          </p>
          <p className="text-fd-muted-foreground text-sm">
            {progressLine(mine)}. Named {mine.workerName}, in {view.account.name}.
          </p>
          {mine.message !== undefined && (
            <p className="text-fd-muted-foreground text-sm">{mine.message}</p>
          )}
          <Actions>
            <button type="button" className={FLARE} onClick={() => actions.continueMine()}>
              Continue
            </button>
            <button
              type="button"
              className={secondary}
              onClick={() => actions.requestRemove(mine.id)}
            >
              Remove…
            </button>
          </Actions>
        </div>
      )}
      {others.length > 0 && (
        <div className="grid gap-2">
          <Text>
            {mine === null
              ? `${view.account.name} has ${others.length === 1 ? "an installation" : "installations"} that started in another browser and did not finish. Continue ${others.length === 1 ? "it" : "one"} in that browser, or remove ${others.length === 1 ? "it" : "them"} here.`
              : "Also started in another browser and not finished:"}
          </Text>
          <ul className="grid gap-2">
            {others.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-fd-border px-4 py-3"
              >
                <span className="grid gap-0.5">
                  <Strong>{item.address}</Strong>
                  <span className="text-fd-muted-foreground text-sm">{progressLine(item)}</span>
                </span>
                <button
                  type="button"
                  className={quiet}
                  onClick={() => actions.requestRemove(item.id)}
                >
                  Remove…
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {mine === null && (
        <Actions>
          <button type="button" className={primary} onClick={() => actions.startNew()}>
            Start a new installation
          </button>
        </Actions>
      )}
    </div>
  );
}

function NameStep({
  view,
  actions,
  canGoBack,
}: {
  view: Extract<DeployView, { step: "name" }>;
  actions: DeployActions;
  canGoBack: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    actions.submitName();
  }
  return (
    <form className="grid gap-3" onSubmit={submit} noValidate>
      <Title>Name your Appflare</Title>
      <Text>
        In <Strong>{view.account.name}</Strong>, Appflare and the database and storage it keeps its
        data in are called by this name. Keep the suggestion unless you install Appflare more than
        once.
      </Text>
      <div className="grid gap-1.5">
        <label htmlFor={id} className="font-medium text-sm">
          Name
        </label>
        <input
          id={id}
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={view.value}
          maxLength={58}
          disabled={view.checking}
          aria-invalid={view.error !== null}
          aria-describedby={view.error === null ? hintId : `${errorId} ${hintId}`}
          onChange={(event) => actions.editName(event.target.value)}
          className={field}
        />
        {view.error !== null && <ErrorText id={errorId}>{view.error}</ErrorText>}
        <p id={hintId} className="text-fd-muted-foreground text-sm">
          Lowercase letters, digits and dashes.
        </p>
      </div>
      <Actions>
        <button type="submit" className={primary} disabled={view.checking}>
          {view.checking ? "Checking…" : "Continue"}
        </button>
        {canGoBack && <BackButton actions={actions} />}
      </Actions>
    </form>
  );
}

function AddressStep({
  view,
  actions,
  canGoBack,
}: {
  view: Extract<DeployView, { step: "address" }>;
  actions: DeployActions;
  canGoBack: boolean;
}) {
  const id = useId();
  const { account, workerName, zones, choice } = view;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    actions.submitAddress();
  }
  if (zones === null) {
    return (
      <div className="grid gap-3">
        <Title>Choose Appflare's address</Title>
        <Spinner label={`Reading the domains of ${account.name}…`} />
      </div>
    );
  }
  const sub = account.workersDevSubdomain;
  const devAddress = sub === null ? null : workersDevAddress(workerName, sub);
  if (choice === null) {
    return (
      <div className="grid gap-3">
        <Title>Choose Appflare's address</Title>
        <Callout tone="warning">
          {account.name} has no domain on Cloudflare and no workers.dev address yet. Open Workers
          &amp; Pages in the Cloudflare dashboard once to get a workers.dev address, or add a domain
          to the account, then check again.
        </Callout>
        <Actions>
          <button type="button" className={primary} onClick={() => actions.refreshAddress()}>
            Check again
          </button>
          {canGoBack && <BackButton actions={actions} />}
        </Actions>
      </div>
    );
  }
  const domain = choice.kind === "domain" ? choice : null;
  const preview = domain !== null ? hostnameFor(domain) : null;
  const firstZone: Zone | undefined = zones[0];
  return (
    <form className="grid gap-4" onSubmit={submit} noValidate>
      <Title>Choose Appflare's address</Title>
      <Text>
        You open Appflare and sign in at this address. Your passkeys belong to it, so choose the one
        you want to keep.
      </Text>
      <fieldset className="grid gap-3" disabled={view.checking}>
        <legend className="sr-only">Address</legend>
        {firstZone !== undefined && (
          <div className="grid gap-3 rounded-lg border border-fd-border p-4 has-[:checked]:border-fd-primary">
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name={`${id}-kind`}
                checked={domain !== null}
                onChange={() =>
                  actions.chooseAddress({
                    kind: "domain",
                    zone: firstZone.name,
                    subdomain: "appflare",
                  })
                }
                className="mt-1 size-4 accent-[#fb6b00]"
              />
              <span className="grid gap-0.5">
                <span className="font-medium">On your domain</span>
                <span className="text-fd-muted-foreground text-sm">
                  Cloudflare creates the DNS record and the security certificate.
                </span>
              </span>
            </label>
            {domain !== null && (
              <div className="grid gap-2 pl-7">
                <div className="grid grid-cols-[minmax(6rem,1fr)_auto_minmax(0,1.5fr)] items-center gap-1.5 sm:grid-cols-[12rem_auto_minmax(0,1fr)]">
                  <label htmlFor={`${id}-sub`} className="sr-only">
                    Subdomain
                  </label>
                  <input
                    id={`${id}-sub`}
                    type="text"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={domain.subdomain}
                    onChange={(event) =>
                      actions.chooseAddress({ ...domain, subdomain: event.target.value })
                    }
                    className={`${field}`}
                    aria-describedby={`${id}-preview`}
                  />
                  <span aria-hidden="true">.</span>
                  {zones.length > 1 ? (
                    <>
                      <label htmlFor={`${id}-zone`} className="sr-only">
                        Domain
                      </label>
                      <select
                        id={`${id}-zone`}
                        value={domain.zone}
                        onChange={(event) =>
                          actions.chooseAddress({ ...domain, zone: event.target.value })
                        }
                        className={`${field} min-w-0`}
                      >
                        {zones.map((zone) => (
                          <option key={zone.id} value={zone.name}>
                            {zone.name}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                      {domain.zone}
                    </span>
                  )}
                </div>
                <p id={`${id}-preview`} className="text-fd-muted-foreground text-sm">
                  {preview === null ? (
                    "Use letters, digits and dashes in front of the domain."
                  ) : (
                    <>
                      Appflare will be at <Strong>https://{preview}</Strong>
                    </>
                  )}
                </p>
              </div>
            )}
          </div>
        )}
        <div className="grid gap-1 rounded-lg border border-fd-border p-4 has-[:checked]:border-fd-primary">
          <label className="flex items-start gap-3">
            <input
              type="radio"
              name={`${id}-kind`}
              checked={choice.kind === "workers-dev"}
              disabled={devAddress === null}
              onChange={() => actions.chooseAddress({ kind: "workers-dev" })}
              className="mt-1 size-4 accent-[#fb6b00]"
            />
            <span className="grid gap-0.5">
              <span className="font-medium">Cloudflare's free address</span>
              <span className="text-fd-muted-foreground text-sm [overflow-wrap:anywhere]">
                {devAddress === null
                  ? "This account has no workers.dev address yet. Open Workers & Pages in the Cloudflare dashboard once to get one."
                  : devAddress}
              </span>
            </span>
          </label>
        </div>
        {firstZone === undefined && (
          <p className="text-fd-muted-foreground text-sm">
            {account.name} has no domain on Cloudflare. You can move Appflare to one later in its
            settings.
          </p>
        )}
      </fieldset>
      {view.error !== null && <ErrorText>{view.error}</ErrorText>}
      <Actions>
        <button type="submit" className={primary} disabled={view.checking}>
          {view.checking ? "Checking the address…" : "Continue"}
        </button>
        {canGoBack && <BackButton actions={actions} />}
      </Actions>
    </form>
  );
}

/** What a deploy of `plan` creates, in words. */
export function createdItems(plan: Pick<Plan, "workerName" | "hostname" | "address">): string[] {
  const name = plan.workerName;
  const jobs = name === "appflare" ? "appflare-jobs" : `${name}-jobs`;
  return [
    `Appflare itself, a Worker named ${name}`,
    `Its database, a D1 database named ${name}`,
    `Its settings storage, a KV namespace named ${name}-kv`,
    `Its background jobs, a Workflow named ${jobs}, and a schedule for its regular checks`,
    plan.hostname === null
      ? `Its address on workers.dev, ${plan.address}`
      : `The custom domain ${plan.hostname}, with its DNS record and certificate`,
  ];
}

function Review({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "review" }>;
  actions: DeployActions;
}) {
  const { plan } = view;
  const rows: Array<[string, ReactNode]> = [
    ["Cloudflare account", plan.account.name],
    ["Name", plan.workerName],
    ["Address", <Strong key="address">{plan.address}</Strong>],
    [
      "Release",
      view.release !== null ? (
        `Appflare ${view.release}, the newest release, its signature checked`
      ) : view.releaseError === null ? (
        <span key="release" className="text-fd-muted-foreground">
          Looking it up…
        </span>
      ) : (
        <span key="release" className="text-red-600 dark:text-red-400">
          Not available
        </span>
      ),
    ],
  ];
  return (
    <div className="grid gap-4">
      <Title>Check before you deploy</Title>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-fd-muted-foreground text-sm sm:pt-0.5">{term}</dt>
            <dd className="[overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-2">
        <h3 className="font-medium">Created in {plan.account.name}</h3>
        <ul className="grid list-disc gap-1 pl-5 text-fd-muted-foreground text-sm">
          {createdItems(plan).map((item) => (
            <li key={item} className="[overflow-wrap:anywhere]">
              {item}
            </li>
          ))}
        </ul>
        <p className="text-fd-muted-foreground text-sm">
          Nothing that is already in the account is changed. If you stop before the end, you can
          remove exactly these again.
        </p>
      </div>
      {view.releaseError !== null && (
        <Callout tone="error">
          <p>{view.releaseError}</p>
          <div>
            <button type="button" className={secondary} onClick={() => actions.retryRelease()}>
              Try again
            </button>
          </div>
        </Callout>
      )}
      {view.error !== null && <ErrorText>{view.error}</ErrorText>}
      <Actions>
        <button
          type="button"
          className={FLARE}
          disabled={view.release === null || view.starting}
          onClick={() => actions.deploy()}
        >
          {view.starting ? "Starting…" : "Deploy Appflare"}
        </button>
        {!view.starting && <BackButton actions={actions} />}
      </Actions>
    </div>
  );
}

function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  const value = total === 0 ? 0 : Math.min(done, total);
  return (
    <div className="grid gap-1.5">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={value}
        className="h-2 overflow-hidden rounded-full bg-fd-secondary"
      >
        <div
          className="h-full rounded-full bg-[#fb6b00] transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${total === 0 ? 4 : Math.max(4, (value / total) * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** Why the deploy is waiting, in plain words, for the steps that wait on DNS and certificates. */
export function waitingExplanation(active: Active, stepId: string): string | null {
  if (stepId === "proof" && active.hostname !== null) {
    return `Cloudflare is setting up ${active.hostname}: a DNS record, so browsers can find it, and a security certificate, so it opens over https. A new address usually needs one to five minutes, sometimes longer. This page keeps checking.`;
  }
  if (stepId === "proof") {
    return "Cloudflare is putting Appflare live at its workers.dev address. That usually takes under a minute. This page keeps checking.";
  }
  if (stepId === "domain") {
    return `Cloudflare is connecting ${active.hostname ?? "your domain"} to Appflare.`;
  }
  return null;
}

function Deploying({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "deploying" }>;
  actions: DeployActions;
}) {
  const { active, progress } = view;
  const waiting = progress?.status === "waiting";
  const explanation =
    waiting && progress !== null ? waitingExplanation(active, progress.step.id) : null;
  return (
    <div className="grid gap-4">
      <Title>Deploying Appflare</Title>
      <Text>
        To <Strong>{active.address}</Strong>, in {active.accountName}
        {active.release !== null && <>, Appflare {active.release}</>}.
      </Text>
      {progress === null ? (
        <Spinner label="Starting…" />
      ) : (
        <div className="grid gap-2">
          <ProgressBar done={progress.done} total={progress.total} label="Deploy progress" />
          <p className="flex items-center gap-2 font-medium">
            {waiting ? (
              <ClockIcon aria-hidden="true" className="size-5 shrink-0 text-amber-600" />
            ) : (
              <CircleNotchIcon
                aria-hidden="true"
                className="size-5 shrink-0 animate-spin motion-reduce:animate-none"
              />
            )}
            <span>
              Step {Math.min(progress.done + 1, progress.total)} of {progress.total}:{" "}
              {progress.step.label}
            </span>
          </p>
          {progress.message !== undefined && !waiting && (
            <p className="text-fd-muted-foreground text-sm">{progress.message}</p>
          )}
        </div>
      )}
      {waiting && (
        <Callout>
          <p>{explanation ?? progress?.message ?? "Waiting a moment before the next step."}</p>
          {explanation !== null && progress?.message !== undefined && (
            <p className="text-xs opacity-80">{progress.message}</p>
          )}
          <div>
            <button type="button" className={secondary} onClick={() => actions.checkNow()}>
              Check now
            </button>
          </div>
        </Callout>
      )}
      {view.offerWorkersDev && active.workersDevAddress !== null && (
        <Callout tone="warning">
          <p>
            Rather not wait? Appflare also has a workers.dev address,{" "}
            <Strong>{active.workersDevAddress}</Strong>, which needs no new certificate. You can
            open it there instead. Your sign-in and passkeys then belong to that address, and moving
            to {active.hostname} later means signing in again there.
          </p>
          <div>
            <button type="button" className={secondary} onClick={() => actions.openAtWorkersDev()}>
              Open at workers.dev instead
            </button>
          </div>
        </Callout>
      )}
      {view.offline && (
        <Callout tone="warning">
          This page lost contact with Appflare's installer. It tries again by itself.
        </Callout>
      )}
      <p className="text-fd-muted-foreground text-sm">
        {active.remembered
          ? "You can close this tab. The installation keeps its progress, and this page continues it when you come back in this browser."
          : "This browser does not let the page remember the installation, so keep this tab open until it finishes."}
      </p>
    </div>
  );
}

function DeployFailed({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "deploy-failed" }>;
  actions: DeployActions;
}) {
  return (
    <div className="grid gap-4">
      <Title>The deployment stopped</Title>
      {view.progress !== null && (
        <p className="flex items-center gap-2 font-medium">
          <WarningIcon aria-hidden="true" className="size-5 shrink-0 text-red-600" />
          {view.progress.step.label}
        </p>
      )}
      <Callout tone="error">{view.message}</Callout>
      <Actions>
        <button type="button" className={primary} onClick={() => actions.retry()}>
          Try again
        </button>
        <button
          type="button"
          className={secondary}
          onClick={() => actions.requestRemove(view.active.local.installationId)}
        >
          Remove this installation…
        </button>
      </Actions>
    </div>
  );
}

const HANDOFF_PROBLEMS: Record<HandoffProblem, (address: string) => string> = {
  unreachable: (a) => `${a} does not answer yet. Nothing was sent to it.`,
  unverified: (a) =>
    `Something answers at ${a}, but it is not your new Appflare, so nothing was sent to it.`,
  refused: () =>
    "Your new Appflare did not accept this browser's setup key. If you started this installation in another browser, finish it there.",
  "rate-limited": () =>
    "Your new Appflare asked this page to wait after several attempts. Try again in a few minutes.",
  invalid: () => "Your new Appflare gave an answer this page cannot use. Try again.",
};

function HandingOff({ view }: { view: Extract<DeployView, { step: "handing-off" }> }) {
  return (
    <div className="grid gap-3">
      <Title>Connecting your new Appflare</Title>
      <Spinner label={`Checking that ${view.address} is your new Appflare…`} />
      <Text>
        Then this page gives it its Cloudflare connection, straight from your browser. The installer
        never sees it.
      </Text>
    </div>
  );
}

function HandoffFailed({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "handoff-failed" }>;
  actions: DeployActions;
}) {
  return (
    <div className="grid gap-4">
      <Title>Appflare is deployed but not connected yet</Title>
      <Callout tone="error">{HANDOFF_PROBLEMS[view.problem](view.address)}</Callout>
      <Actions>
        <button type="button" className={primary} onClick={() => actions.retry()}>
          Try again
        </button>
        <button
          type="button"
          className={secondary}
          onClick={() => actions.requestRemove(view.active.local.installationId)}
        >
          Remove this installation…
        </button>
      </Actions>
    </div>
  );
}

function Opening({ view }: { view: Extract<DeployView, { step: "opening" }> }) {
  return (
    <div className="grid gap-3">
      <h2 className="flex items-center gap-2 font-semibold text-xl tracking-tight">
        <CheckIcon aria-hidden="true" className="size-6 text-green-600" />
        Appflare is ready
      </h2>
      <Text>
        Opening <Strong>{view.address}</Strong>, where you create your owner account. The link works
        for 30 minutes.
      </Text>
      <Actions>
        <a href={view.ownerSetupUrl} className={FLARE} rel="noreferrer">
          Open Appflare
          <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
        </a>
      </Actions>
    </div>
  );
}

function SetUp({ view }: { view: Extract<DeployView, { step: "set-up" }> }) {
  return (
    <div className="grid gap-3">
      <Title>This Appflare is set up</Title>
      <Text>
        It already has its owner, so there is nothing left to do here. Sign in at{" "}
        <Strong>{view.address}</Strong>.
      </Text>
      <Actions>
        <a href={view.address} className={primary} rel="noreferrer">
          Open Appflare
        </a>
      </Actions>
    </div>
  );
}

function removalItems(target: RemovalTarget): string[] {
  return createdItems({
    workerName: target.workerName,
    hostname: target.hostname,
    address: target.address,
  }).map((item) => item.replace(/^Its address on workers\.dev, /, "Its workers.dev address, "));
}

function ConfirmRemove({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "confirm-remove" }>;
  actions: DeployActions;
}) {
  const { target } = view;
  return (
    <div className="grid gap-4">
      <Title>Remove this installation?</Title>
      <Text>
        This deletes, from {target.account.name}, what the installation of{" "}
        <Strong>{target.address}</Strong> created, as far as it got:
      </Text>
      <ul className="grid list-disc gap-1 pl-5 text-sm">
        {removalItems(target).map((item) => (
          <li key={item} className="[overflow-wrap:anywhere]">
            {item}
          </li>
        ))}
      </ul>
      <Text>
        Anything that was in the account before is left alone. Appflare's data goes with its
        database, and this cannot be undone.
      </Text>
      <Actions>
        <button type="button" className={danger} onClick={() => actions.confirmRemove()}>
          Remove
        </button>
        <BackButton actions={actions} label="Cancel" />
      </Actions>
    </div>
  );
}

function Removing({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "removing" }>;
  actions: DeployActions;
}) {
  const { progress } = view;
  return (
    <div className="grid gap-4">
      <Title>Removing the installation</Title>
      {progress === null ? (
        <Spinner label="Starting…" />
      ) : (
        <div className="grid gap-2">
          <ProgressBar done={progress.done} total={progress.total} label="Removal progress" />
          <p className="text-fd-muted-foreground text-sm">{progress.step.label}</p>
        </div>
      )}
      {view.error !== null && (
        <Callout tone="error">
          <p>{view.error}</p>
          <div>
            <button type="button" className={secondary} onClick={() => actions.retry()}>
              Try again
            </button>
          </div>
        </Callout>
      )}
    </div>
  );
}

function Removed({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "removed" }>;
  actions: DeployActions;
}) {
  return (
    <div className="grid gap-3">
      <Title>Removed</Title>
      <Text>
        The installation of <Strong>{view.target.address}</Strong> and everything it created are
        gone, and the installer no longer keeps a record of it.
      </Text>
      <Actions>
        <button type="button" className={primary} onClick={() => actions.afterRemoval()}>
          Start a new installation
        </button>
      </Actions>
    </div>
  );
}

function ErrorStep({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "error" }>;
  actions: DeployActions;
}) {
  return (
    <div className="grid gap-3">
      <Title>That did not work</Title>
      <Callout tone="error">{view.message}</Callout>
      <Actions>
        {view.retry !== null && (
          <button type="button" className={primary} onClick={() => actions.retry()}>
            Try again
          </button>
        )}
        <button type="button" className={secondary} onClick={() => actions.reconnect()}>
          Connect Cloudflare again
        </button>
      </Actions>
    </div>
  );
}

export interface DeployPanelProps {
  view: DeployView;
  actions: DeployActions;
  canGoBack: boolean;
}

/** The current step. */
export function DeployPanel({ view, actions, canGoBack }: DeployPanelProps) {
  switch (view.step) {
    case "loading":
      return (
        <div className="grid gap-3">
          <Spinner label="Getting ready…" />
          <noscript>
            <p className="text-fd-muted-foreground">
              This page needs JavaScript to install Appflare.
            </p>
          </noscript>
        </div>
      );
    case "unavailable":
      return <Unavailable view={view} />;
    case "welcome":
      return <Welcome view={view} actions={actions} />;
    case "working":
      return <Spinner label={view.label} />;
    case "account":
      return <AccountPicker view={view} actions={actions} />;
    case "unfinished":
      return <UnfinishedList view={view} actions={actions} />;
    case "name":
      return <NameStep view={view} actions={actions} canGoBack={canGoBack} />;
    case "address":
      return <AddressStep view={view} actions={actions} canGoBack={canGoBack} />;
    case "review":
      return <Review view={view} actions={actions} />;
    case "deploying":
      return <Deploying view={view} actions={actions} />;
    case "deploy-failed":
      return <DeployFailed view={view} actions={actions} />;
    case "handing-off":
      return <HandingOff view={view} />;
    case "handoff-failed":
      return <HandoffFailed view={view} actions={actions} />;
    case "opening":
      return <Opening view={view} />;
    case "set-up":
      return <SetUp view={view} />;
    case "confirm-remove":
      return <ConfirmRemove view={view} actions={actions} />;
    case "removing":
      return <Removing view={view} actions={actions} />;
    case "removed":
      return <Removed view={view} actions={actions} />;
    case "error":
      return <ErrorStep view={view} actions={actions} />;
  }
}
