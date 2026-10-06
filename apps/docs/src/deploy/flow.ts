import { StorageRefused, startAuthorization } from "./authorize.ts";
import type { OAuthSetup } from "./config.ts";
import { handoffHash, newHandoffSecret } from "./handoff-secret.ts";
import {
  type Account,
  type CleanupAnswer,
  type InstallerApi,
  InstallerApiError,
  type StepAnswer,
  type Unfinished,
  type Zone,
} from "./installer-api.ts";
import { HandoffError, type ManagerApi } from "./manager-api.ts";
import type { DeployStorage, LocalInstallation } from "./storage.ts";
import { AuthorizationNeeded, type TokenKeeper } from "./tokens.ts";

/**
 * The deploy page's steps, as a state machine the page only draws:
 *
 * Connect Cloudflare → account (a choice only when the sign-in reaches
 * several) → unfinished installations, if the account has any → name →
 * address → review → deploy (the hosted installer's `/step`, repeated) →
 * handoff (the browser checks the new Appflare's proof, then sends it the
 * Cloudflare grant) → owner setup at the chosen address.
 *
 * Every call to Cloudflare, the hosted installer, the new Appflare, the
 * clock and the browser's address bar goes through {@link FlowDeps}, so the
 * whole journey runs in tests without a browser.
 */

export const DEFAULT_WORKER_NAME = "appflare";
/** The subdomain proposed on a chosen domain. */
export const DEFAULT_SUBDOMAIN = "appflare";

/** Worker names the installer accepts (as create-appflare's). */
export const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
/** One or more DNS labels in front of a domain; empty means the domain itself. */
const SUBDOMAIN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** How long the domain may keep Appflare waiting before the workers.dev address is offered. */
export const OFFER_WORKERS_DEV_AFTER_MS = 30_000;
/** How long the page shows where it is going before it opens owner setup. */
export const OPEN_DELAY_MS = 1_500;
/** The wait between two progress requests when the installer names none. */
export const DEFAULT_WAIT_MS = 3_000;
/** The wait after the installer could not be reached. */
export const OFFLINE_WAIT_MS = 5_000;

export type AddressChoice =
  | { kind: "domain"; zone: string; subdomain: string }
  | { kind: "workers-dev" };

/** What the review shows and the deploy creates. */
export interface Plan {
  account: Account;
  workerName: string;
  hostname: string | null;
  /** The complete address Appflare will be opened at. */
  address: string;
  /** How the address step was left, to return to it the same way. */
  choice: AddressChoice;
}

/** An installation this browser is deploying or handing off. */
export interface Active {
  local: LocalInstallation;
  accountName: string;
  workerName: string;
  hostname: string | null;
  address: string;
  /** The workers.dev address, when the installation also has one besides a domain. */
  workersDevAddress: string | null;
  release: string | null;
  /** False when this browser could not keep it for a later visit. */
  remembered: boolean;
}

/** An unfinished installation about to be removed. */
export interface RemovalTarget {
  id: string;
  /** Null when this browser does not hold its key (started elsewhere). */
  key: string | null;
  account: Account;
  workerName: string;
  hostname: string | null;
  address: string;
}

export type Notice =
  /** The Cloudflare connection ran out or was withdrawn. */
  | "reconnect"
  /** The installation this browser remembered is finished or was removed. */
  | "finished-elsewhere"
  /** The sign-in does not reach the account of the remembered installation. */
  | "account-unreachable";

export type HandoffProblem =
  /** The address does not answer yet. */
  | "unreachable"
  /** Something answers, but it is not this installation. */
  | "unverified"
  /** Appflare refused the setup key. */
  | "refused"
  | "rate-limited"
  /** Appflare's answer was not usable. */
  | "invalid";

export type DeployView =
  | { step: "loading" }
  | { step: "unavailable"; reason: "unregistered-origin" | "callback-elsewhere" }
  | {
      step: "welcome";
      /** This browser remembers an unfinished installation. */
      unfinished: boolean;
      notice: Notice | null;
      busy: boolean;
      error: string | null;
    }
  | { step: "working"; label: string }
  | { step: "account"; accounts: Account[]; notice: Notice | null }
  | {
      step: "unfinished";
      account: Account;
      /** The one this browser holds the key for. */
      mine: Unfinished | null;
      /** Started in another browser: they can only be removed from here. */
      others: Unfinished[];
      notice: Notice | null;
      /** Why the one this browser holds cannot be continued. */
      error?: string;
    }
  | { step: "name"; account: Account; value: string; checking: boolean; error: string | null }
  | {
      step: "address";
      account: Account;
      workerName: string;
      /** Null while loading. */
      zones: Zone[] | null;
      /** Null when the account has neither a domain nor a workers.dev address. */
      choice: AddressChoice | null;
      checking: boolean;
      error: string | null;
    }
  | {
      step: "review";
      plan: Plan;
      /** Null while it is being looked up. */
      release: string | null;
      releaseError: string | null;
      starting: boolean;
      error: string | null;
    }
  | {
      step: "deploying";
      active: Active;
      progress: StepAnswer | null;
      /** The installer did not answer the last request; the page keeps trying. */
      offline: boolean;
      /** The domain has kept Appflare waiting long enough to offer workers.dev. */
      offerWorkersDev: boolean;
    }
  | { step: "deploy-failed"; active: Active; progress: StepAnswer | null; message: string }
  | { step: "handing-off"; active: Active; address: string }
  | { step: "handoff-failed"; active: Active; address: string; problem: HandoffProblem }
  | { step: "opening"; address: string; ownerSetupUrl: string }
  /** Appflare already has its owner: nothing more to do here. */
  | { step: "set-up"; address: string }
  | { step: "confirm-remove"; target: RemovalTarget; back: DeployView }
  | {
      step: "removing";
      target: RemovalTarget;
      progress: CleanupAnswer | null;
      error: string | null;
    }
  | { step: "removed"; target: RemovalTarget }
  | { step: "error"; message: string; retry: "accounts" | null };

export interface FlowDeps {
  setup: OAuthSetup;
  storage: DeployStorage;
  tokens: TokenKeeper;
  api: InstallerApi;
  manager: ManagerApi;
  /** The page's origin: where the new Appflare reports back. */
  origin: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Leaves the page for `url` (Cloudflare's consent page, or owner setup). */
  navigate: (url: string) => void;
}

const GENERIC_ERROR = "Something went wrong. Try again.";

function messageOf(error: unknown): string {
  return error instanceof InstallerApiError ? error.message : GENERIC_ERROR;
}

function needsAuthorization(error: unknown): boolean {
  return (
    error instanceof AuthorizationNeeded ||
    (error instanceof InstallerApiError && error.needsAuthorization)
  );
}

export function workersDevAddress(workerName: string, subdomain: string): string {
  return `https://${workerName}.${subdomain}.workers.dev`;
}

/**
 * The address an installation is opened at, worked out here from its name,
 * its hostname and the account's workers.dev subdomain, never taken from the
 * installer: the installer knows the proof key, so only the address itself
 * keeps the grant from going anywhere but where the visitor chose. Null when
 * the parts do not make an address.
 */
export function addressFor(
  workerName: string,
  hostname: string | null,
  subdomain: string | null,
): string | null {
  if (hostname !== null) {
    let url: URL;
    try {
      url = new URL(`https://${hostname}`);
    } catch {
      return null;
    }
    return url.hostname === hostname && url.port === "" ? `https://${hostname}` : null;
  }
  if (subdomain === null || !WORKER_NAME.test(workerName) || !/^[a-z0-9-]{1,63}$/.test(subdomain)) {
    return null;
  }
  return workersDevAddress(workerName, subdomain);
}

/** What the page says when the installer names another address than the one it should. */
export function addressMismatch(reported: string, expected: string): string {
  return `Appflare's installer gives this installation the address ${reported}, not ${expected}, so this page stops here and sends nothing to either. Remove this installation and start again.`;
}

/** The hostname for a domain choice, or null when the typed subdomain is not one. */
export function hostnameFor(choice: { zone: string; subdomain: string }): string | null {
  const sub = choice.subdomain.trim().toLowerCase().replace(/\.+$/, "");
  if (sub === "") return choice.zone;
  if (!SUBDOMAIN.test(sub)) return null;
  const hostname = `${sub}.${choice.zone}`;
  return hostname.length <= 253 ? hostname : null;
}

export class DeployFlow {
  private view: DeployView = { step: "loading" };
  private readonly listeners = new Set<() => void>();
  /** Bumped by every move; an answer that arrives for an older one is ignored. */
  private generation = 0;
  private accounts: Account[] = [];
  /** The account's domains, read once per account. */
  private zones: { accountId: string; list: Promise<Zone[]> } | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly deps: FlowDeps) {}

  state(): DeployView {
    return this.view;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops whatever is running (the page is going away). */
  dispose(): void {
    this.generation++;
    this.wake?.();
  }

  private set(view: DeployView): void {
    this.view = view;
    for (const listener of this.listeners) listener();
  }

  private move(): number {
    this.wake?.();
    return ++this.generation;
  }

  private current(generation: number): boolean {
    return generation === this.generation;
  }

  /** Waits `ms`, or less when someone asks to check now. */
  private async pause(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      void this.deps.sleep(ms).then(resolve);
    });
    this.wake = null;
  }

  // --- Arrival and sign-in ---------------------------------------------------

  /** The first step, once the page runs in the browser. */
  start(): void {
    const { setup, storage, tokens } = this.deps;
    if (!setup.ok) {
      this.set({ step: "unavailable", reason: setup.reason });
      return;
    }
    if (tokens.grant() === null) {
      this.set({
        step: "welcome",
        unfinished: storage.installation.read() !== null,
        notice: null,
        busy: false,
        error: null,
      });
      return;
    }
    void this.loadAccounts();
  }

  /** Connect Cloudflare: off to Cloudflare's consent page. */
  async connect(): Promise<void> {
    const { setup, storage } = this.deps;
    if (!setup.ok) return;
    const view = this.view;
    const welcome =
      view.step === "welcome"
        ? view
        : {
            step: "welcome" as const,
            unfinished: storage.installation.read() !== null,
            notice: null,
            busy: false,
            error: null,
          };
    const generation = this.move();
    this.set({ ...welcome, busy: true, error: null });
    try {
      const url = await startAuthorization(setup, storage, this.deps.now());
      if (!this.current(generation)) return;
      this.deps.navigate(url);
    } catch (error) {
      if (!this.current(generation)) return;
      this.set({
        ...welcome,
        busy: false,
        error:
          error instanceof StorageRefused
            ? "This browser does not let the page keep anything, not even for this tab, so it cannot sign in. Allow site data for this site (private windows often block it), or install Appflare from the command line instead."
            : GENERIC_ERROR,
      });
    }
  }

  /** Signs in again, with another Cloudflare login if the visitor wants. */
  reconnect(): Promise<void> {
    this.deps.tokens.forget();
    return this.connect();
  }

  private toReconnect(): void {
    this.move();
    this.deps.tokens.forget();
    this.set({
      step: "welcome",
      unfinished: this.deps.storage.installation.read() !== null,
      notice: "reconnect",
      busy: false,
      error: null,
    });
  }

  private fail(error: unknown, retry: "accounts" | null): void {
    if (needsAuthorization(error)) {
      this.toReconnect();
      return;
    }
    this.set({ step: "error", message: messageOf(error), retry });
  }

  // --- Account ---------------------------------------------------------------

  async loadAccounts(): Promise<void> {
    const generation = this.move();
    this.set({ step: "working", label: "Reading your Cloudflare accounts…" });
    let accounts: Account[];
    try {
      accounts = await this.deps.api.accounts();
    } catch (error) {
      if (this.current(generation)) this.fail(error, "accounts");
      return;
    }
    if (!this.current(generation)) return;
    this.accounts = accounts;
    if (accounts.length === 0) {
      this.set({
        step: "error",
        message:
          "This Cloudflare login has no account Appflare can be installed in. Connect with a login that has one.",
        retry: null,
      });
      return;
    }
    const local = this.deps.storage.installation.read();
    if (local !== null) {
      const account = accounts.find((a) => a.id === local.accountId);
      if (account === undefined) {
        this.set({ step: "account", accounts, notice: "account-unreachable" });
        return;
      }
      await this.openAccount(account);
      return;
    }
    const [only] = accounts;
    if (accounts.length === 1 && only !== undefined) {
      await this.openAccount(only);
      return;
    }
    this.set({ step: "account", accounts, notice: null });
  }

  async chooseAccount(accountId: string): Promise<void> {
    if (this.view.step !== "account") return;
    const account = this.accounts.find((a) => a.id === accountId);
    if (account !== undefined) await this.openAccount(account);
  }

  /** The account's unfinished installations, if it has any; else straight to the name. */
  private async openAccount(account: Account, notice: Notice | null = null): Promise<void> {
    const generation = this.move();
    this.set({
      step: "working",
      label: `Looking for unfinished installations in ${account.name}…`,
    });
    let list: Unfinished[];
    try {
      list = await this.deps.api.find(account.id);
    } catch (error) {
      if (this.current(generation)) this.fail(error, "accounts");
      return;
    }
    if (!this.current(generation)) return;
    const local = this.deps.storage.installation.read();
    let mine: Unfinished | null = null;
    let shown = notice;
    if (local !== null && local.accountId === account.id) {
      mine = list.find((i) => i.id === local.installationId) ?? null;
      if (mine === null) {
        this.deps.storage.installation.clear();
        shown = "finished-elsewhere";
      }
    }
    const others = list.filter((i) => i !== mine);
    if (mine !== null || others.length > 0) {
      this.set({ step: "unfinished", account, mine, others, notice: shown });
      return;
    }
    this.toName(account, DEFAULT_WORKER_NAME);
  }

  // --- Name and address ------------------------------------------------------

  /** From the unfinished installations: start another one instead. */
  startNew(): void {
    const view = this.view;
    if (view.step !== "unfinished" || view.mine !== null) return;
    this.toName(view.account, DEFAULT_WORKER_NAME);
  }

  private toName(account: Account, value: string): void {
    this.move();
    // Read early, so the address step rarely waits. A failure shows there.
    this.zonesOf(account).catch(() => undefined);
    this.set({ step: "name", account, value, checking: false, error: null });
  }

  editName(value: string): void {
    const view = this.view;
    if (view.step !== "name" || view.checking) return;
    this.set({ ...view, value, error: null });
  }

  async submitName(): Promise<void> {
    const view = this.view;
    if (view.step !== "name" || view.checking) return;
    const name = view.value.trim().toLowerCase();
    if (!WORKER_NAME.test(name)) {
      this.set({
        ...view,
        error:
          "Use lowercase letters, digits and dashes, up to 58 characters, starting and ending with a letter or digit.",
      });
      return;
    }
    const generation = this.move();
    this.set({ ...view, value: name, checking: true, error: null });
    try {
      const result = await this.deps.api.check({
        accountId: view.account.id,
        workerName: name,
        hostname: null,
      });
      if (!this.current(generation)) return;
      if (result.workerName === "taken") {
        this.set({
          ...view,
          value: name,
          checking: false,
          error: `Something in this Cloudflare account already uses the name "${name}". Choose another name.`,
        });
        return;
      }
    } catch (error) {
      if (!this.current(generation)) return;
      if (needsAuthorization(error)) return this.toReconnect();
      this.set({ ...view, value: name, checking: false, error: messageOf(error) });
      return;
    }
    await this.toAddress(view.account, name, null);
  }

  private async toAddress(
    account: Account,
    workerName: string,
    previous: AddressChoice | null,
  ): Promise<void> {
    const generation = this.move();
    const base = { step: "address" as const, account, workerName, checking: false, error: null };
    this.set({ ...base, zones: null, choice: previous });
    let zones: Zone[];
    try {
      zones = await this.zonesOf(account);
    } catch (error) {
      this.zones = null;
      if (!this.current(generation)) return;
      if (needsAuthorization(error)) return this.toReconnect();
      this.set({ ...base, zones: [], choice: previous ?? this.defaultChoice(account, []) });
      return;
    }
    if (!this.current(generation)) return;
    this.set({ ...base, zones, choice: previous ?? this.defaultChoice(account, zones) });
  }

  /** Reads the account's domains and workers.dev address again (after setting one up). */
  async refreshAddress(): Promise<void> {
    const view = this.view;
    if (view.step !== "address" || view.checking) return;
    this.zones = null;
    let account = view.account;
    try {
      const accounts = await this.deps.api.accounts();
      this.accounts = accounts;
      account = accounts.find((a) => a.id === account.id) ?? account;
    } catch (error) {
      if (needsAuthorization(error)) return this.toReconnect();
    }
    await this.toAddress(account, view.workerName, null);
  }

  private zonesOf(account: Account): Promise<Zone[]> {
    if (this.zones === null || this.zones.accountId !== account.id) {
      this.zones = { accountId: account.id, list: this.deps.api.zones(account.id) };
    }
    return this.zones.list;
  }

  private defaultChoice(account: Account, zones: Zone[]): AddressChoice | null {
    const [first] = zones;
    if (first !== undefined)
      return { kind: "domain", zone: first.name, subdomain: DEFAULT_SUBDOMAIN };
    return account.workersDevSubdomain === null ? null : { kind: "workers-dev" };
  }

  chooseAddress(choice: AddressChoice): void {
    const view = this.view;
    if (view.step !== "address" || view.checking) return;
    if (choice.kind === "workers-dev" && view.account.workersDevSubdomain === null) return;
    if (choice.kind === "domain" && !view.zones?.some((z) => z.name === choice.zone)) return;
    this.set({ ...view, choice, error: null });
  }

  async submitAddress(): Promise<void> {
    const view = this.view;
    if (view.step !== "address" || view.checking || view.choice === null) return;
    const { account, workerName, choice } = view;
    let hostname: string | null = null;
    let address: string;
    if (choice.kind === "domain") {
      hostname = hostnameFor(choice);
      if (hostname === null) {
        this.set({
          ...view,
          error:
            "Use letters, digits and dashes in front of the domain, for example appflare. Leave it empty for the domain itself.",
        });
        return;
      }
      address = `https://${hostname}`;
    } else {
      if (account.workersDevSubdomain === null) return;
      address = workersDevAddress(workerName, account.workersDevSubdomain);
    }
    const generation = this.move();
    this.set({ ...view, checking: true, error: null });
    try {
      const result = await this.deps.api.check({ accountId: account.id, workerName, hostname });
      if (!this.current(generation)) return;
      const conflict =
        result.hostname !== null && result.hostname !== "free" ? result.hostname.detail : null;
      if (conflict !== null || result.workerName === "taken") {
        this.set({
          ...view,
          checking: false,
          error:
            conflict ??
            `Something in this Cloudflare account already uses the name "${workerName}". Go back and choose another name.`,
        });
        return;
      }
    } catch (error) {
      if (!this.current(generation)) return;
      if (needsAuthorization(error)) return this.toReconnect();
      this.set({ ...view, checking: false, error: messageOf(error) });
      return;
    }
    await this.toReview({ account, workerName, hostname, address, choice });
  }

  // --- Review and deploy -----------------------------------------------------

  private async toReview(plan: Plan): Promise<void> {
    const generation = this.move();
    const base = { step: "review" as const, plan, starting: false, error: null };
    this.set({ ...base, release: null, releaseError: null });
    try {
      const { version } = await this.deps.api.release();
      if (this.current(generation)) this.set({ ...base, release: version, releaseError: null });
    } catch (error) {
      if (!this.current(generation)) return;
      if (needsAuthorization(error)) return this.toReconnect();
      this.set({ ...base, release: null, releaseError: messageOf(error) });
    }
  }

  /** Looks the release up again after it failed. */
  async retryRelease(): Promise<void> {
    const view = this.view;
    if (view.step === "review" && view.releaseError !== null) await this.toReview(view.plan);
  }

  async deploy(): Promise<void> {
    const view = this.view;
    if (view.step !== "review" || view.starting || view.release === null) return;
    const { plan } = view;
    const generation = this.move();
    this.set({ ...view, starting: true, error: null });
    const secret = newHandoffSecret();
    let created: Awaited<ReturnType<InstallerApi["create"]>>;
    try {
      created = await this.deps.api.create({
        accountId: plan.account.id,
        workerName: plan.workerName,
        hostname: plan.hostname,
        handoffHash: await handoffHash(secret),
      });
    } catch (error) {
      if (!this.current(generation)) return;
      if (needsAuthorization(error)) return this.toReconnect();
      this.set({ ...view, starting: false, error: messageOf(error) });
      return;
    }
    if (!this.current(generation)) return;
    const local: LocalInstallation = {
      installationId: created.installationId,
      key: created.key,
      handoffSecret: secret,
      accountId: plan.account.id,
    };
    const remembered = this.deps.storage.installation.write(local);
    const sub = plan.account.workersDevSubdomain;
    const active: Active = {
      local,
      accountName: plan.account.name,
      workerName: plan.workerName,
      hostname: plan.hostname,
      // The address reviewed, whatever the installer answers.
      address: plan.address,
      workersDevAddress: plan.hostname === null ? null : addressFor(plan.workerName, null, sub),
      release: created.release.version,
      remembered,
    };
    if (created.address !== plan.address) {
      this.set({
        step: "deploy-failed",
        active,
        progress: null,
        message: addressMismatch(created.address, plan.address),
      });
      return;
    }
    await this.runDeploy(active);
  }

  /** Continues the installation this browser holds the key for. */
  async continueMine(): Promise<void> {
    const view = this.view;
    if (view.step !== "unfinished" || view.mine === null) return;
    const local = this.deps.storage.installation.read();
    if (local === null || local.installationId !== view.mine.id) return;
    const { mine, account } = view;
    const sub = account.workersDevSubdomain;
    const address = addressFor(mine.workerName, mine.hostname, sub);
    if (address === null || address !== mine.address) {
      this.set({
        ...view,
        error: addressMismatch(mine.address, address ?? "the address it was set up for"),
      });
      return;
    }
    await this.runDeploy({
      local,
      accountName: account.name,
      workerName: mine.workerName,
      hostname: mine.hostname,
      address,
      workersDevAddress: mine.hostname === null ? null : addressFor(mine.workerName, null, sub),
      release: mine.release.version,
      remembered: true,
    });
  }

  /** Repeats the installer's `/step` until Appflare is deployed, then hands off. */
  private async runDeploy(active: Active): Promise<void> {
    const generation = this.move();
    let progress: StepAnswer | null = null;
    let waitingSince: number | null = null;
    this.set({ step: "deploying", active, progress, offline: false, offerWorkersDev: false });
    while (this.current(generation)) {
      let answer: StepAnswer;
      try {
        answer = await this.deps.api.step(active.local.installationId, active.local.key);
      } catch (error) {
        if (!this.current(generation)) return;
        if (needsAuthorization(error)) return this.toReconnect();
        if (error instanceof InstallerApiError && error.status === 404) {
          this.deps.storage.installation.clear();
          this.set({
            step: "error",
            message:
              "The installer no longer has this installation. It was finished or removed, perhaps from another window.",
            retry: null,
          });
          return;
        }
        if (error instanceof InstallerApiError && error.retryable) {
          this.set({
            step: "deploying",
            active,
            progress,
            offline: error.status === null,
            offerWorkersDev: false,
          });
          await this.pause(error.retryAfterMs ?? OFFLINE_WAIT_MS);
          continue;
        }
        this.set({ step: "deploy-failed", active, progress, message: messageOf(error) });
        return;
      }
      if (!this.current(generation)) return;
      progress = answer;
      const domainWait =
        answer.status === "waiting" &&
        answer.step.id === "proof" &&
        active.hostname !== null &&
        active.workersDevAddress !== null;
      if (domainWait) waitingSince ??= this.deps.now();
      else waitingSince = null;
      const offerWorkersDev =
        waitingSince !== null && this.deps.now() - waitingSince >= OFFER_WORKERS_DEV_AFTER_MS;
      switch (answer.status) {
        case "running":
          this.set({ step: "deploying", active, progress, offline: false, offerWorkersDev });
          continue;
        case "waiting":
          this.set({ step: "deploying", active, progress, offline: false, offerWorkersDev });
          await this.pause(answer.retryAfterMs ?? DEFAULT_WAIT_MS);
          continue;
        case "deployed":
          await this.handOff(active, active.address);
          return;
        case "failed":
          this.set({
            step: "deploy-failed",
            active,
            progress,
            message: answer.message ?? "A step of the installation did not work.",
          });
          return;
      }
    }
  }

  /** While waiting: ask again now rather than after the pause. */
  checkNow(): void {
    if (this.view.step === "deploying" || this.view.step === "removing") this.wake?.();
  }

  /** After a failed step or handoff: try it again. */
  async retry(): Promise<void> {
    const view = this.view;
    if (view.step === "deploy-failed") await this.runDeploy(view.active);
    else if (view.step === "handoff-failed") await this.handOff(view.active, view.address);
    else if (view.step === "removing" && view.error !== null) await this.runRemoval(view.target);
    else if (view.step === "error" && view.retry === "accounts") await this.loadAccounts();
  }

  /** The domain is still pending: open Appflare at its workers.dev address instead. */
  async openAtWorkersDev(): Promise<void> {
    const view = this.view;
    if (view.step !== "deploying" && view.step !== "deploy-failed") return;
    const address = view.active.workersDevAddress;
    if (address === null) return;
    await this.handOff(view.active, address);
  }

  // --- Handoff ---------------------------------------------------------------

  /**
   * Checks that `address` proves it is this installation, then gives it the
   * grant and the installer's completion details, then opens owner setup.
   * Nothing is sent to an address that has not proved itself.
   */
  private async handOff(active: Active, address: string): Promise<void> {
    const generation = this.move();
    this.set({ step: "handing-off", active, address });
    const secret = active.local.handoffSecret;
    const probe = await this.deps.manager.probe(address, secret);
    if (!this.current(generation)) return;
    if (probe.kind === "unverified") {
      this.set({
        step: "handoff-failed",
        active,
        address,
        problem: probe.reason === "unreachable" ? "unreachable" : "unverified",
      });
      return;
    }
    if (probe.state === "done") {
      this.deps.storage.installation.clear();
      this.set({ step: "set-up", address });
      return;
    }
    let ownerSetupUrl: string;
    try {
      // The newest refresh token: a renewal during the deploy replaced the
      // first one, and one still running is waited for, never raced.
      ownerSetupUrl = await this.deps.tokens.handOver((grant) =>
        this.deps.manager.handOff(address, {
          secret,
          grant: {
            refreshToken: grant.refreshToken,
            clientId: grant.clientId,
            scopes: grant.scopes,
          },
          accountId: active.local.accountId,
          installer: {
            url: this.deps.origin,
            installationId: active.local.installationId,
            key: active.local.key,
          },
        }),
      );
    } catch (error) {
      if (!this.current(generation)) return;
      if (error instanceof AuthorizationNeeded) return this.toReconnect();
      if (error instanceof HandoffError && error.kind === "done") {
        this.deps.storage.installation.clear();
        this.set({ step: "set-up", address });
        return;
      }
      const problem: HandoffProblem =
        error instanceof HandoffError && error.kind !== "done" ? error.kind : "invalid";
      this.set({ step: "handoff-failed", active, address, problem });
      return;
    }
    // Appflare refreshes the grant at once, so this tab's copy is spent.
    this.deps.tokens.forget();
    if (!this.current(generation)) return;
    this.set({ step: "opening", address, ownerSetupUrl });
    await this.deps.sleep(OPEN_DELAY_MS);
    if (this.current(generation)) this.deps.navigate(ownerSetupUrl);
  }

  // --- Removal ---------------------------------------------------------------

  /** Asks before removing an unfinished installation. */
  requestRemove(installationId: string): void {
    const view = this.view;
    let target: RemovalTarget | null = null;
    if (view.step === "unfinished") {
      const found = [view.mine, ...view.others].find((i) => i?.id === installationId) ?? null;
      if (found !== null) {
        const local = this.deps.storage.installation.read();
        target = {
          id: found.id,
          key: local !== null && local.installationId === found.id ? local.key : null,
          account: view.account,
          workerName: found.workerName,
          hostname: found.hostname,
          address: found.address,
        };
      }
    } else if (
      (view.step === "deploy-failed" || view.step === "handoff-failed") &&
      view.active.local.installationId === installationId
    ) {
      const account = this.accounts.find((a) => a.id === view.active.local.accountId);
      if (account !== undefined) {
        target = {
          id: installationId,
          key: view.active.local.key,
          account,
          workerName: view.active.workerName,
          hostname: view.active.hostname,
          address: view.active.address,
        };
      }
    }
    if (target === null) return;
    this.move();
    this.set({ step: "confirm-remove", target, back: view });
  }

  async confirmRemove(): Promise<void> {
    const view = this.view;
    if (view.step === "confirm-remove") await this.runRemoval(view.target);
  }

  private async runRemoval(target: RemovalTarget): Promise<void> {
    const generation = this.move();
    let progress: CleanupAnswer | null = null;
    this.set({ step: "removing", target, progress, error: null });
    const done = () => {
      const local = this.deps.storage.installation.read();
      if (local?.installationId === target.id) this.deps.storage.installation.clear();
      this.set({ step: "removed", target });
    };
    while (this.current(generation)) {
      let answer: CleanupAnswer;
      try {
        answer = await this.deps.api.cleanup(target.id, target.key);
      } catch (error) {
        if (!this.current(generation)) return;
        if (needsAuthorization(error)) return this.toReconnect();
        if (error instanceof InstallerApiError && error.status === 404) return done();
        if (error instanceof InstallerApiError && error.code === "already_set_up") {
          const local = this.deps.storage.installation.read();
          if (local?.installationId === target.id) this.deps.storage.installation.clear();
          this.set({ step: "set-up", address: target.address });
          return;
        }
        if (error instanceof InstallerApiError && error.retryable) {
          await this.pause(error.retryAfterMs ?? OFFLINE_WAIT_MS);
          continue;
        }
        this.set({ step: "removing", target, progress, error: messageOf(error) });
        return;
      }
      if (!this.current(generation)) return;
      progress = answer;
      switch (answer.status) {
        case "removed":
          return done();
        case "running":
          this.set({ step: "removing", target, progress, error: null });
          continue;
        case "waiting":
          this.set({ step: "removing", target, progress, error: null });
          await this.pause(answer.retryAfterMs ?? DEFAULT_WAIT_MS);
          continue;
        case "failed":
          this.set({
            step: "removing",
            target,
            progress,
            error: answer.message ?? "Part of the installation could not be removed.",
          });
          return;
      }
    }
  }

  /** After a removal: start a new installation in the same account. */
  async afterRemoval(): Promise<void> {
    const view = this.view;
    if (view.step === "removed") await this.openAccount(view.target.account);
  }

  // --- Back ------------------------------------------------------------------

  /** Whether the current step has a Back. */
  canGoBack(): boolean {
    const view = this.view;
    switch (view.step) {
      case "unfinished":
      case "name":
        return this.accounts.length > 1;
      case "address":
      case "review":
      case "confirm-remove":
        return !("checking" in view && view.checking) && !("starting" in view && view.starting);
      default:
        return false;
    }
  }

  async back(): Promise<void> {
    if (!this.canGoBack()) return;
    const view = this.view;
    switch (view.step) {
      case "unfinished":
      case "name":
        this.move();
        this.set({ step: "account", accounts: this.accounts, notice: null });
        return;
      case "address":
        this.toName(view.account, view.workerName);
        return;
      case "review":
        await this.toAddress(view.plan.account, view.plan.workerName, view.plan.choice);
        return;
      case "confirm-remove":
        this.move();
        this.set(view.back);
        return;
    }
  }
}
