import { AppflareLoader } from "@appflare/brand/loader";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import { Input } from "@cloudflare/kumo/components/input";
import { Meter } from "@cloudflare/kumo/components/meter";
import { Radio } from "@cloudflare/kumo/components/radio";
import { Select } from "@cloudflare/kumo/components/select";
import { Text } from "@cloudflare/kumo/components/text";
import {
  ArrowSquareOutIcon,
  CaretRightIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type FormEvent, type ReactNode, useEffect, useRef } from "react";
import type {
  AddressChoice,
  DeployView,
  FinishedNote,
  HandoffProblem,
  Notice,
  Plan,
  RemovalTarget,
} from "../../deploy/flow.ts";
import { hostnameFor, workersDevAddress } from "../../deploy/flow.ts";
import type { StepAnswer, Unfinished, Zone } from "../../deploy/installer-api.ts";
import { DEPLOY_PATH } from "../../deploy/paths.ts";
import type { ScopeExamples } from "../../deploy/scope-examples.ts";
import { SITE_URL } from "../../lib/shared.ts";
import { BusyButton } from "./busy-button.tsx";
import {
  DeployCard,
  JourneyContext,
  type JourneyStep,
  More,
  STEP_TITLE_ID,
} from "./deploy-shell.tsx";
import { ScopeList } from "./scope-list.tsx";

/**
 * One step of the deploy page, drawn from the state in `deploy/flow.ts`.
 * Nothing here decides anything: every click is a call on {@link DeployActions}.
 * Each step says one short thing; the rest waits behind a "details" fold.
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

/** A primary action spans the card, as on Appflare's own setup screens. */
const WIDE = "w-full justify-center";
/** A secondary action spans the card only on a phone, where actions stack. */
const WIDE_ON_PHONE = "max-sm:w-full max-sm:justify-center";
/** Every button is at least 44 px tall on a phone. */
const TOUCH = "max-sm:h-11";
/** Fields are 44 px tall on a phone, with 16 px text so the browser does not zoom in on them. */
const TOUCH_FIELD = "max-sm:h-11 pointer-coarse:text-[16px]";

/** A value to read whole: an address, a name. */
function Strong({ children }: { children: ReactNode }) {
  return <span className="font-medium text-kumo-default [overflow-wrap:anywhere]">{children}</span>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">{children}</div>;
}

function BackButton({ actions, label = "Back" }: { actions: DeployActions; label?: string }) {
  return (
    <Button variant="ghost" className={`${TOUCH} ${WIDE_ON_PHONE}`} onClick={() => actions.back()}>
      {label}
    </Button>
  );
}

/** A loader and a line saying what is happening, announced politely. */
function Working({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3">
      <AppflareLoader size={20} aria-hidden />
      <Text variant="secondary">{label}</Text>
    </div>
  );
}

function ErrorBanner({ title, children }: { title?: string; children?: ReactNode }) {
  return (
    <div role="alert">
      <Banner
        variant="error"
        icon={<WarningCircleIcon weight="fill" />}
        {...(title === undefined ? {} : { title })}
        description={children}
      />
    </div>
  );
}

function AlertBanner({ children }: { children: ReactNode }) {
  return <Banner variant="alert" icon={<WarningIcon weight="fill" />} description={children} />;
}

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
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

/**
 * The journey step a view shows on its meter, or null for a view without
 * one: nothing before Cloudflare is connected (a first screen should not
 * count steps at you), nothing while the page works or asks about an
 * unfinished installation, and nothing from Deploy on, where the deploy's
 * own progress is the bar.
 */
export function meterOf(view: DeployView): JourneyStep | null {
  switch (view.step) {
    case "account":
      return "account";
    case "name":
      return "name";
    case "address":
      return "address";
    case "review":
      return "review";
    default:
      return null;
  }
}

/**
 * Whether the person at the page has pressed a key or pointed at something
 * since it loaded. The steps the page takes by itself while it starts
 * (loading, then welcome, or reading the accounts after a sign-in) are not
 * theirs, and moving the focus then would pull it from where they put it.
 */
let acted = false;
let listening = false;

function listenForAction(): void {
  if (listening) return;
  listening = true;
  const mark = () => {
    acted = true;
  };
  document.addEventListener("pointerdown", mark, { capture: true, passive: true });
  document.addEventListener("keydown", mark, { capture: true, passive: true });
}

/** For tests: back to a page nobody has touched. */
export function resetStepFocus(): void {
  acted = false;
}

/**
 * Moves the focus to the step's title when the step changes after the
 * person has acted on the page (not on the steps the page takes by itself
 * while it starts, and not while one step only updates), so keyboard and
 * screen reader users start reading at the new step.
 */
export function useFocusOnStepChange(step: string): void {
  const previous = useRef(step);
  useEffect(() => {
    listenForAction();
  }, []);
  useEffect(() => {
    if (previous.current === step) return;
    previous.current = step;
    if (!acted) return;
    document.getElementById(STEP_TITLE_ID)?.focus({ preventScroll: false });
  }, [step]);
}

// --- Steps -------------------------------------------------------------------

const NOTICES: Record<Notice, string> = {
  reconnect: "Your Cloudflare connection ran out. Connect again to carry on. Nothing was lost.",
  "finished-elsewhere":
    "The installation this browser remembered is finished or was removed, so there is nothing to continue.",
  "account-unreachable":
    "This Cloudflare login does not reach the account where you started. Connect with that login, or choose an account to start again.",
};

function Welcome({
  view,
  actions,
  examples,
}: {
  view: Extract<DeployView, { step: "welcome" }>;
  actions: DeployActions;
  examples: ScopeExamples;
}) {
  return (
    <DeployCard
      meter={meterOf(view)}
      title={view.unfinished ? "Continue installing Appflare" : "Install Appflare"}
      description={
        view.unfinished
          ? "Connect Cloudflare to pick up where this browser stopped."
          : "Into your own Cloudflare account, in a few minutes, from this page."
      }
    >
      {view.notice !== null && <AlertBanner>{NOTICES[view.notice]}</AlertBanner>}
      {view.error !== null && <ErrorBanner>{view.error}</ErrorBanner>}
      <BusyButton
        variant="primary"
        size="lg"
        className={`${WIDE} ${TOUCH}`}
        pending={view.busy}
        onClick={() => actions.connect()}
      >
        {view.busy ? "Opening Cloudflare…" : "Connect Cloudflare"}
      </BusyButton>
      <More summary="What Appflare asks Cloudflare for">
        <Text variant="secondary">
          Every permission it uses, all at once, so it never has to ask again when you turn on a
          feature later. Nothing is created until you check and press Deploy.
        </Text>
        <ScopeList examples={examples} />
        <Text variant="secondary">
          Billing is not among them, so Appflare works your Workers plan out from what the account
          can run, or asks you in its settings.
        </Text>
      </More>
    </DeployCard>
  );
}

function Unavailable({ view }: { view: Extract<DeployView, { step: "unavailable" }> }) {
  const site = new URL(SITE_URL).host;
  return (
    <DeployCard
      meter={meterOf(view)}
      title="Sign-in does not work on this copy of the page"
      description={
        view.reason === "unregistered-origin"
          ? `Cloudflare sends you back only to ${site}.`
          : "This copy finishes signing in at another address."
      }
    >
      <LinkButton
        href={`${SITE_URL}${DEPLOY_PATH}`}
        variant="primary"
        className={`${WIDE} ${TOUCH}`}
      >
        Open {site}
        {DEPLOY_PATH.replace(/\/$/, "")}
      </LinkButton>
    </DeployCard>
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
    <DeployCard
      meter={meterOf(view)}
      title="Choose an account"
      description="Your Cloudflare login reaches several. Appflare goes into one."
    >
      {view.notice !== null && (
        <div className="grid gap-2">
          <AlertBanner>{NOTICES[view.notice]}</AlertBanner>
          {view.notice === "account-unreachable" && (
            <Button
              variant="secondary"
              className={`${WIDE} ${TOUCH}`}
              onClick={() => actions.reconnect()}
            >
              Connect with another login
            </Button>
          )}
        </div>
      )}
      <ul className="grid gap-2">
        {view.accounts.map((account) => (
          <li key={account.id}>
            <Button
              variant="secondary"
              size="lg"
              className="h-auto min-h-12 w-full justify-between py-2 text-left"
              onClick={() => actions.chooseAccount(account.id)}
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{account.name}</span>
              <CaretRightIcon aria-hidden className="shrink-0 text-kumo-subtle" />
            </Button>
          </li>
        ))}
      </ul>
    </DeployCard>
  );
}

function progressLine(item: Pick<Unfinished, "done" | "total" | "step" | "status">): string {
  if (item.status === "deployed") return "Deployed, not connected yet";
  if (item.status === "removing") return "Being removed";
  return `Step ${Math.min(item.done + 1, item.total)} of ${item.total}: ${item.step.label}`;
}

function UnfinishedList({
  view,
  actions,
  canGoBack,
}: {
  view: Extract<DeployView, { step: "unfinished" }>;
  actions: DeployActions;
  canGoBack: boolean;
}) {
  const { mine, others } = view;
  const one = others.length === 1;
  return (
    <DeployCard
      meter={meterOf(view)}
      title={mine !== null ? "Continue installing Appflare?" : "Unfinished installations"}
      description={
        mine !== null
          ? "This browser started one and it is not finished."
          : `Started in another browser, in ${view.account.name}. Continue ${one ? "it" : "one"} there, or remove ${one ? "it" : "them"} here.`
      }
    >
      {view.notice !== null && <AlertBanner>{NOTICES[view.notice]}</AlertBanner>}
      {view.error !== undefined && <ErrorBanner>{view.error}</ErrorBanner>}
      {mine !== null && (
        <div className="grid gap-4 rounded-lg p-4 ring ring-kumo-hairline">
          <div className="grid gap-1">
            <Strong>{hostOf(mine.address)}</Strong>
            <Text variant="secondary" size="sm">
              {progressLine(mine)}
            </Text>
          </div>
          <Actions>
            <Button
              variant="primary"
              className={`${TOUCH} ${WIDE_ON_PHONE}`}
              onClick={() => actions.continueMine()}
            >
              Continue
            </Button>
            <Button
              variant="secondary-destructive"
              className={`${TOUCH} ${WIDE_ON_PHONE}`}
              onClick={() => actions.requestRemove(mine.id)}
            >
              Remove…
            </Button>
          </Actions>
        </div>
      )}
      {others.length > 0 && (
        <div className="grid gap-2">
          {mine !== null && (
            <Text variant="secondary" size="sm">
              Also unfinished, started in another browser:
            </Text>
          )}
          <ul className="grid gap-2">
            {others.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-4 py-3 ring ring-kumo-hairline"
              >
                <span className="grid min-w-0 gap-0.5">
                  <Strong>{hostOf(item.address)}</Strong>
                  <Text variant="secondary" size="sm" as="span">
                    {progressLine(item)}
                  </Text>
                </span>
                <Button
                  variant="secondary-destructive"
                  size="sm"
                  className={TOUCH}
                  onClick={() => actions.requestRemove(item.id)}
                >
                  Remove…
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {mine === null && (
        <Actions>
          <Button
            variant="primary"
            className={`${WIDE} ${TOUCH} sm:w-auto`}
            onClick={() => actions.startNew()}
          >
            Start a new installation
          </Button>
          {canGoBack && <BackButton actions={actions} />}
        </Actions>
      )}
    </DeployCard>
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
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    actions.submitName();
  }
  return (
    <DeployCard
      meter={meterOf(view)}
      title="Name your Appflare"
      description="Keep the suggestion unless you install Appflare more than once."
    >
      <form className="grid gap-5" onSubmit={submit} noValidate>
        <Input
          label="Name"
          name="worker-name"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          translate="no"
          value={view.value}
          maxLength={58}
          disabled={view.checking}
          onChange={(event) => actions.editName(event.target.value)}
          className={TOUCH_FIELD}
          description={`Lowercase letters, digits and dashes. Its database and storage in ${view.account.name} get the same name.`}
          {...(view.error === null ? {} : { error: view.error })}
        />
        <Actions>
          <BusyButton
            type="submit"
            variant="primary"
            className={`${WIDE} ${TOUCH} sm:w-auto`}
            pending={view.checking}
          >
            {view.checking ? "Checking…" : "Continue"}
          </BusyButton>
          {canGoBack && <BackButton actions={actions} />}
        </Actions>
      </form>
    </DeployCard>
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
  const { account, workerName, zones, choice } = view;
  const title = "Choose Appflare's address";
  const description = "You open Appflare and sign in here. Pick the one you will keep.";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    actions.submitAddress();
  }
  if (zones === null) {
    return (
      <DeployCard meter={meterOf(view)} title={title} description={description}>
        <Working label={`Reading the domains of ${account.name}…`} />
      </DeployCard>
    );
  }
  const sub = account.workersDevSubdomain;
  const devAddress = sub === null ? null : workersDevAddress(workerName, sub);
  if (choice === null) {
    return (
      <DeployCard
        meter={meterOf(view)}
        title={title}
        description={`${account.name} has no domain and no workers.dev address yet.`}
      >
        <Text variant="secondary">
          Open Workers &amp; Pages in the Cloudflare dashboard once to get a workers.dev address, or
          add a domain to the account. Then check again.
        </Text>
        <Actions>
          <Button
            variant="primary"
            className={`${WIDE} ${TOUCH} sm:w-auto`}
            onClick={() => actions.refreshAddress()}
          >
            Check again
          </Button>
          {canGoBack && <BackButton actions={actions} />}
        </Actions>
      </DeployCard>
    );
  }
  const domain = choice.kind === "domain" ? choice : null;
  const preview = domain !== null ? hostnameFor(domain) : null;
  const firstZone: Zone | undefined = zones[0];
  const kind = choice.kind === "domain" ? "domain" : "workers-dev";
  return (
    <DeployCard meter={meterOf(view)} title={title} description={description}>
      <form className="grid gap-5" onSubmit={submit} noValidate>
        <Radio.Group
          appearance="card"
          value={kind}
          disabled={view.checking}
          onValueChange={(next) => {
            if (next === "workers-dev") actions.chooseAddress({ kind: "workers-dev" });
            else if (next === "domain" && firstZone !== undefined && domain === null) {
              actions.chooseAddress({
                kind: "domain",
                zone: firstZone.name,
                subdomain: "appflare",
              });
            }
          }}
        >
          <Radio.Legend className="sr-only">Address</Radio.Legend>
          {firstZone !== undefined && (
            <Radio.Item
              value="domain"
              label="On your domain"
              description="Cloudflare adds the DNS record and the certificate."
            />
          )}
          <Radio.Item
            value="workers-dev"
            label="Cloudflare's free address"
            disabled={devAddress === null}
            description={
              <span className="[overflow-wrap:anywhere]">
                {devAddress ?? "Not set up in this account yet."}
              </span>
            }
          />
        </Radio.Group>
        {domain !== null && (
          <div className="grid gap-2">
            <div className="grid items-end gap-3 sm:gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.3fr)]">
              <Input
                label="Subdomain"
                name="subdomain"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                translate="no"
                value={domain.subdomain}
                disabled={view.checking}
                onChange={(event) =>
                  actions.chooseAddress({ ...domain, subdomain: event.target.value })
                }
                className={TOUCH_FIELD}
              />
              <span aria-hidden="true" className="pb-2 text-kumo-subtle max-sm:hidden">
                .
              </span>
              <div className="min-w-0">
                {zones.length > 1 ? (
                  <Select
                    label="Domain"
                    hideLabel={false}
                    value={domain.zone}
                    disabled={view.checking}
                    onValueChange={(zone) => {
                      if (typeof zone === "string") actions.chooseAddress({ ...domain, zone });
                    }}
                    className={`w-full ${TOUCH_FIELD}`}
                    items={Object.fromEntries(zones.map((zone) => [zone.name, zone.name]))}
                  />
                ) : (
                  <div className="grid gap-1.5">
                    <Text size="sm" bold as="span">
                      Domain
                    </Text>
                    <span className="flex h-9 items-center font-medium [overflow-wrap:anywhere] max-sm:h-11">
                      {domain.zone}
                    </span>
                  </div>
                )}
              </div>
            </div>
            <Text variant="secondary" size="sm">
              {preview === null ? (
                "Use letters, digits and dashes in front of the domain."
              ) : (
                <>
                  Appflare will be at <Strong>https://{preview}</Strong>
                </>
              )}
            </Text>
          </div>
        )}
        {firstZone === undefined && (
          <Text variant="secondary" size="sm">
            {account.name} has no domain on Cloudflare. You can move Appflare to one later in its
            settings.
          </Text>
        )}
        {view.error !== null && <ErrorBanner>{view.error}</ErrorBanner>}
        <Actions>
          <BusyButton
            type="submit"
            variant="primary"
            className={`${WIDE} ${TOUCH} sm:w-auto`}
            pending={view.checking}
          >
            {view.checking ? "Checking the address…" : "Continue"}
          </BusyButton>
          {canGoBack && <BackButton actions={actions} />}
        </Actions>
      </form>
    </DeployCard>
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
    ["Account", plan.account.name],
    [
      "Name",
      <span key="name" translate="no">
        {plan.workerName}
      </span>,
    ],
    ["Address", <Strong key="address">{plan.address}</Strong>],
    [
      "Release",
      view.release !== null ? (
        <span key="release" className="inline-flex flex-wrap items-center gap-2">
          Appflare {view.release}
          <Badge variant="success" icon={<CheckCircleIcon weight="fill" />}>
            Signature checked
          </Badge>
        </span>
      ) : view.releaseError === null ? (
        <span key="release" className="inline-flex items-center gap-2 text-kumo-subtle">
          <AppflareLoader size={14} aria-hidden />
          Looking it up…
        </span>
      ) : (
        <span key="release" className="text-kumo-danger">
          Not available
        </span>
      ),
    ],
  ];
  return (
    <DeployCard
      meter={meterOf(view)}
      title="Check and deploy"
      description="Nothing is created in your account until you press Deploy."
    >
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
        {rows.map(([term, value]) => (
          <div key={term} className="grid gap-0.5 sm:contents">
            <dt className="text-kumo-subtle text-sm">{term}</dt>
            <dd className="[overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      <More summary={`What gets created in ${plan.account.name}`}>
        <ul className="grid list-disc gap-1 pl-5">
          {createdItems(plan).map((item) => (
            <li key={item} className="[overflow-wrap:anywhere]">
              {item}
            </li>
          ))}
        </ul>
        <Text variant="secondary">
          Nothing already in the account changes. If you stop before the end, you can remove exactly
          these again.
        </Text>
      </More>
      {view.releaseError !== null && (
        <div className="grid gap-2">
          <ErrorBanner>{view.releaseError}</ErrorBanner>
          <Button
            variant="secondary"
            className={`${TOUCH} ${WIDE_ON_PHONE} sm:justify-self-start`}
            onClick={() => actions.retryRelease()}
          >
            Try again
          </Button>
        </div>
      )}
      {view.error !== null && <ErrorBanner>{view.error}</ErrorBanner>}
      <Actions>
        <BusyButton
          variant="primary"
          size="lg"
          className={`${WIDE} ${TOUCH} sm:w-auto`}
          disabled={view.release === null}
          pending={view.starting}
          onClick={() => actions.deploy()}
        >
          {view.starting ? "Starting…" : "Deploy Appflare"}
        </BusyButton>
        {!view.starting && <BackButton actions={actions} />}
      </Actions>
    </DeployCard>
  );
}

/** One short line for each warning a finished step can give; the installer's words on demand. */
const NOTICE_LINES: Record<string, string> = {
  schedules: "Appflare's regular checks, such as looking for updates, will not run on their own.",
};

/**
 * Warnings from finished steps, kept on screen from the step that gave them
 * to owner setup: one line each, the full explanation folded away.
 */
function Notices({ notices }: { notices: FinishedNote[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="grid gap-2">
      {notices.map((notice) => (
        <Banner
          key={notice.id}
          variant="alert"
          icon={<WarningIcon weight="fill" />}
          description={
            <div className="grid gap-1">
              <span>{NOTICE_LINES[notice.id] ?? `${notice.label}: needs your attention.`}</span>
              <More summary="Why">
                <span>{notice.message}</span>
              </More>
            </div>
          }
        />
      ))}
    </div>
  );
}

/** "Step 6 of 11": the step under way. */
function stepPosition(progress: Pick<StepAnswer, "done" | "total">): string {
  return `Step ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`;
}

/** "5 of 11 done": what the bar shows. */
function stepsDone(progress: Pick<StepAnswer, "done" | "total">): string {
  return `${Math.min(progress.done, progress.total)} of ${progress.total} done`;
}

/**
 * The installer's steps as a bar of the steps finished, with the step under
 * way named beside it, so the number next to the bar is the bar's own.
 */
function StepMeter({ progress }: { progress: Pick<StepAnswer, "done" | "total"> }) {
  return (
    <Meter
      label={stepPosition(progress)}
      customValue={stepsDone(progress)}
      value={Math.min(progress.done, progress.total)}
      max={Math.max(progress.total, 1)}
      getAriaValueText={() => stepsDone(progress)}
    />
  );
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Check now, busy while it checks, and what the last check found. */
function CheckNow({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "deploying" }>;
  actions: DeployActions;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <BusyButton
        variant="secondary"
        size="sm"
        className={TOUCH}
        pending={view.checking}
        onClick={() => actions.checkNow()}
      >
        {view.checking ? "Checking…" : "Check now"}
      </BusyButton>
      <span role="status" className="text-kumo-subtle text-sm">
        {view.checking ? (
          // The button already shows it; this says it to screen readers.
          <span className="sr-only">Checking…</span>
        ) : view.checkedAt !== null ? (
          `Still waiting (checked at ${timeFormat.format(view.checkedAt)}).`
        ) : (
          ""
        )}
      </span>
    </div>
  );
}

/** Why the deploy waits on the address, in one line. */
export function addressWaitLine(view: Extract<DeployView, { step: "deploying" }>): string {
  const { hostname } = view.active;
  return hostname !== null
    ? `Cloudflare is setting up ${hostname} and its certificate. This usually takes 1 to 5 minutes.`
    : "Cloudflare is putting Appflare live at its workers.dev address. This usually takes under a minute.";
}

function Deploying({
  view,
  actions,
}: {
  view: Extract<DeployView, { step: "deploying" }>;
  actions: DeployActions;
}) {
  const { active, progress, reconnecting, wait } = view;
  const label = reconnecting ? "Reconnecting…" : (progress?.step.label ?? "Starting…");
  const announcement = reconnecting
    ? "Reconnecting to Appflare's installer."
    : progress === null
      ? "Starting."
      : `${stepPosition(progress)}: ${progress.step.label}. ${stepsDone(progress)}.`;
  // A message about the step itself while it runs ("Uploaded 120 of 180 files").
  const running = progress?.status === "running" && !reconnecting ? progress.message : undefined;
  const details = [
    ...view.notes.map((note) => ({ key: note.id, label: note.label, text: note.message })),
    // What the installer's last look at the address found, for the curious.
    ...(wait === "address" && progress?.message !== undefined
      ? [{ key: "now", label: "Last check", text: progress.message }]
      : []),
  ];
  return (
    // The deploy's own meter is the one that moves here; the journey's would be a second bar.
    <DeployCard
      meter={null}
      title="Installing Appflare"
      description={
        <>
          To <Strong>{hostOf(active.address)}</Strong>, in {active.accountName}
        </>
      }
    >
      <div className="grid gap-3">
        {/* Busy, and silent: the status line after it announces the progress. */}
        <div aria-busy="true" className="flex items-start gap-3">
          <span className="flex h-lh items-center">
            <AppflareLoader size={22} aria-hidden />
          </span>
          <div className="grid min-w-0 gap-0.5">
            <Text bold>{label}</Text>
            {running !== undefined && (
              <Text variant="secondary" size="sm">
                {running}
              </Text>
            )}
          </div>
        </div>
        {progress !== null && <StepMeter progress={progress} />}
        <p role="status" className="sr-only">
          {announcement}
        </p>
      </div>
      <Notices notices={active.notices} />
      {!reconnecting && wait === "address" && (
        <div className="grid gap-2">
          <Text variant="secondary">{addressWaitLine(view)}</Text>
          <CheckNow view={view} actions={actions} />
        </div>
      )}
      {!reconnecting && wait === "long" && (
        <div className="grid gap-2">
          <Text variant="secondary">
            {progress?.message ?? "Appflare's installer asked this page to wait."} This page keeps
            trying.
          </Text>
          <CheckNow view={view} actions={actions} />
        </div>
      )}
      {view.offerWorkersDev && active.workersDevAddress !== null && active.hostname !== null && (
        <RatherNotWait
          hostname={active.hostname}
          workersDevAddress={active.workersDevAddress}
          onOpen={() => actions.openAtWorkersDev()}
        />
      )}
      <Text variant="secondary" size="sm">
        {active.remembered
          ? "You can close this tab. Come back to this page in this browser to continue."
          : "Keep this tab open until it finishes: this browser does not let the page remember it."}
      </Text>
      {details.length > 0 && (
        <More summary="Details">
          <ul className="grid gap-1.5">
            {details.map((item) => (
              <li key={item.key}>
                <span className="text-kumo-default">{item.label}:</span> {item.text}
              </li>
            ))}
          </ul>
        </More>
      )}
    </DeployCard>
  );
}

/**
 * The way around a slow certificate, offered only after a long wait: one
 * line, the button, and the consequence on demand.
 */
function RatherNotWait({
  hostname,
  workersDevAddress,
  onOpen,
}: {
  hostname: string;
  workersDevAddress: string;
  onOpen: () => void;
}) {
  return (
    <div className="grid gap-2 border-kumo-hairline border-t pt-4">
      <Text>
        Rather not wait? Set up your owner account at workers.dev now; Appflare moves to {hostname}{" "}
        once it is ready.
      </Text>
      <Button
        variant="secondary"
        size="sm"
        className={`${TOUCH} ${WIDE_ON_PHONE} sm:justify-self-start`}
        onClick={onOpen}
      >
        Open at workers.dev
      </Button>
      <More summary="What changes">
        <Text variant="secondary">
          Appflare opens at <Strong>{workersDevAddress}</Strong>, which needs no new certificate.
          The installation and your Cloudflare connection are the same either way.
        </Text>
      </More>
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
    <DeployCard
      meter={meterOf(view)}
      title="The installation stopped"
      {...(view.progress === null ? {} : { description: `At: ${view.progress.step.label}` })}
    >
      <ErrorBanner>{view.message}</ErrorBanner>
      <Actions>
        <Button
          variant="primary"
          className={`${WIDE} ${TOUCH} sm:w-auto`}
          onClick={() => actions.retry()}
        >
          Try again
        </Button>
        <Button
          variant="secondary-destructive"
          className={`${TOUCH} ${WIDE_ON_PHONE}`}
          onClick={() => actions.requestRemove(view.active.local.installationId)}
        >
          Remove this installation…
        </Button>
      </Actions>
    </DeployCard>
  );
}

const minutesText = (minutes: number | undefined) =>
  minutes === undefined ? "a few minutes" : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;

// Only the first two happen before anything is sent; the rest describe how
// Appflare answered after this page sent it its Cloudflare connection.
const HANDOFF_PROBLEMS: Record<HandoffProblem, (address: string, minutes?: number) => string> = {
  unreachable: (a) => `${a} does not answer yet. Nothing was sent to it.`,
  unverified: (a) =>
    `Something answers at ${a}, but it is not your new Appflare, so nothing was sent to it.`,
  refused: () =>
    "Your new Appflare did not accept this browser's setup key. If you started this installation in another browser, finish it there.",
  elsewhere: (_a, m) =>
    `Someone is finishing the setup of your new Appflare in another browser, with a Cloudflare API token. Finish it there, or try again here in ${minutesText(m)}.`,
  declined: () =>
    "Your new Appflare could not use this Cloudflare connection. Connect Cloudflare again, choosing the account Appflare is installed in and allowing every permission it asks for.",
  "rate-limited": () =>
    "Your new Appflare asked this page to wait after several attempts. Try again in a few minutes.",
  busy: () =>
    "Your new Appflare is busy with another step, or could not reach Cloudflare just now. Try again in a minute.",
  failed: () =>
    "Your new Appflare received the request but could not finish connecting to Cloudflare. Try again.",
  "no-answer": () =>
    "Your new Appflare stopped answering while this page was connecting it. Try again.",
  invalid: () => "Your new Appflare gave an answer this page cannot use. Try again.",
};

function HandingOff({ view }: { view: Extract<DeployView, { step: "handing-off" }> }) {
  return (
    <DeployCard
      meter={meterOf(view)}
      title="Connecting your new Appflare"
      description={
        <>
          At <Strong>{hostOf(view.address)}</Strong>
        </>
      }
    >
      <Working label="Checking that this is your new Appflare…" />
      <Notices notices={view.active.notices} />
      <More summary="What happens here">
        <Text variant="secondary">
          Once the address proves it is this installation, this page gives it its Cloudflare
          connection, straight from your browser. The installer never sees it.
        </Text>
      </More>
    </DeployCard>
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
    <DeployCard
      meter={meterOf(view)}
      title="Appflare is installed but not connected yet"
      description={
        <>
          At <Strong>{hostOf(view.address)}</Strong>
        </>
      }
    >
      <ErrorBanner>{HANDOFF_PROBLEMS[view.problem](view.address, view.minutes)}</ErrorBanner>
      <Notices notices={view.active.notices} />
      <Actions>
        {view.problem === "declined" ? (
          // The connection itself was refused: sending it again cannot help.
          <Button
            variant="primary"
            className={`${WIDE} ${TOUCH} sm:w-auto`}
            onClick={() => actions.reconnect()}
          >
            Connect Cloudflare again
          </Button>
        ) : (
          <Button
            variant="primary"
            className={`${WIDE} ${TOUCH} sm:w-auto`}
            onClick={() => actions.retry()}
          >
            Try again
          </Button>
        )}
        <Button
          variant="secondary-destructive"
          className={`${TOUCH} ${WIDE_ON_PHONE}`}
          onClick={() => actions.requestRemove(view.active.local.installationId)}
        >
          Remove this installation…
        </Button>
      </Actions>
    </DeployCard>
  );
}

function Opening({ view }: { view: Extract<DeployView, { step: "opening" }> }) {
  return (
    <DeployCard
      meter={meterOf(view)}
      title={
        <span className="inline-flex items-center gap-2">
          <CheckCircleIcon aria-hidden weight="fill" className="shrink-0 text-kumo-success" />
          Appflare is ready
        </span>
      }
      description={
        <>
          Opening <Strong>{hostOf(view.address)}</Strong> to create your owner account.
        </>
      }
    >
      <LinkButton
        href={view.ownerSetupUrl}
        variant="primary"
        size="lg"
        className={`${WIDE} ${TOUCH}`}
        rel="noreferrer"
        icon={ArrowSquareOutIcon}
      >
        Open Appflare
      </LinkButton>
      <Text variant="secondary" size="sm">
        The link works for 30 minutes.
      </Text>
      <Notices notices={view.notices} />
    </DeployCard>
  );
}

function SetUp({ view }: { view: Extract<DeployView, { step: "set-up" }> }) {
  return (
    <DeployCard
      meter={meterOf(view)}
      title="This Appflare is already set up"
      description={
        <>
          It has its owner. Sign in at <Strong>{hostOf(view.address)}</Strong>.
        </>
      }
    >
      <LinkButton
        href={view.address}
        variant="primary"
        className={`${WIDE} ${TOUCH}`}
        rel="noreferrer"
      >
        Open Appflare
      </LinkButton>
      <Notices notices={view.notices} />
    </DeployCard>
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
    <DeployCard
      meter={null}
      title="Remove this installation?"
      description={
        <>
          Everything the installation of <Strong>{hostOf(target.address)}</Strong> created, as far
          as it got. This cannot be undone.
        </>
      }
    >
      <More summary={`What goes from ${target.account.name}`}>
        <ul className="grid list-disc gap-1 pl-5">
          {removalItems(target).map((item) => (
            <li key={item} className="[overflow-wrap:anywhere]">
              {item}
            </li>
          ))}
        </ul>
        <Text variant="secondary">
          Anything that was in the account before stays. Appflare's data goes with its database.
        </Text>
      </More>
      <Actions>
        <Button
          variant="destructive"
          className={`${WIDE} ${TOUCH} sm:w-auto`}
          onClick={() => actions.confirmRemove()}
        >
          Remove
        </Button>
        <BackButton actions={actions} label="Cancel" />
      </Actions>
    </DeployCard>
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
    <DeployCard
      meter={null}
      title="Removing the installation"
      description={
        <>
          Of <Strong>{hostOf(view.target.address)}</Strong>
        </>
      }
    >
      {view.error === null && (
        <div className="grid gap-3">
          <Working label={progress === null ? "Starting…" : progress.step.label} />
          {progress !== null && <StepMeter progress={progress} />}
        </div>
      )}
      {view.error !== null && (
        <div className="grid gap-2">
          <ErrorBanner>{view.error}</ErrorBanner>
          <Button
            variant="primary"
            className={`${WIDE} ${TOUCH} sm:w-auto sm:justify-self-start`}
            onClick={() => actions.retry()}
          >
            Try again
          </Button>
        </div>
      )}
    </DeployCard>
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
    <DeployCard
      meter={null}
      title="Removed"
      description={
        <>
          The installation of <Strong>{hostOf(view.target.address)}</Strong> and everything it
          created are gone. The installer keeps no record of it.
        </>
      }
    >
      <Button
        variant="primary"
        className={`${WIDE} ${TOUCH}`}
        onClick={() => actions.afterRemoval()}
      >
        Start a new installation
      </Button>
    </DeployCard>
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
    <DeployCard meter={meterOf(view)} title="That did not work">
      <ErrorBanner>{view.message}</ErrorBanner>
      <Actions>
        {view.retry !== null && (
          <Button
            variant="primary"
            className={`${WIDE} ${TOUCH} sm:w-auto`}
            onClick={() => actions.retry()}
          >
            Try again
          </Button>
        )}
        <Button
          variant="secondary"
          className={`${TOUCH} ${WIDE_ON_PHONE}`}
          onClick={() => actions.reconnect()}
        >
          Connect Cloudflare again
        </Button>
      </Actions>
    </DeployCard>
  );
}

function Loading({ view }: { view: Extract<DeployView, { step: "loading" }> }) {
  return (
    <DeployCard
      meter={meterOf(view)}
      title="Install Appflare"
      description="Into your own Cloudflare account, in a few minutes, from this page."
    >
      <Working label="Getting ready…" />
      <noscript>
        <Text variant="secondary">This page needs JavaScript to install Appflare.</Text>
      </noscript>
    </DeployCard>
  );
}

export interface DeployPanelProps {
  view: DeployView;
  actions: DeployActions;
  canGoBack: boolean;
  /**
   * Whether this sign-in reaches several accounts, so choosing one is a step
   * of its own; when it is not, the meter does not count it.
   */
  accountStep?: boolean;
  /** Example apps for the permissions' reasons, from the catalog the site is built with. */
  examples?: ScopeExamples;
}

/** The current step, in its card. */
export function DeployPanel({
  view,
  actions,
  canGoBack,
  accountStep = false,
  examples = {},
}: DeployPanelProps) {
  useFocusOnStepChange(view.step);
  return (
    <JourneyContext.Provider value={{ accountStep }}>
      <Step view={view} actions={actions} canGoBack={canGoBack} examples={examples} />
    </JourneyContext.Provider>
  );
}

function Step({ view, actions, canGoBack, examples = {} }: DeployPanelProps) {
  switch (view.step) {
    case "loading":
      return <Loading view={view} />;
    case "unavailable":
      return <Unavailable view={view} />;
    case "welcome":
      return <Welcome view={view} actions={actions} examples={examples} />;
    case "working":
      return (
        <DeployCard meter={meterOf(view)} title="Connected to Cloudflare">
          <Working label={view.label} />
        </DeployCard>
      );
    case "account":
      return <AccountPicker view={view} actions={actions} />;
    case "unfinished":
      return <UnfinishedList view={view} actions={actions} canGoBack={canGoBack} />;
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
