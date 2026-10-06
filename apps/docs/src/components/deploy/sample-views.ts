import type { CallbackView } from "../../deploy/callback.ts";
import type { Active, DeployView, FinishedNote, Plan, RemovalTarget } from "../../deploy/flow.ts";
import type { Account, StepAnswer, Unfinished } from "../../deploy/installer-api.ts";

/**
 * One example of every step of the deploy page and the callback, for the
 * render tests. The secrets in them are made up and must never be drawn.
 */

export const SAMPLE_SECRETS = {
  key: "key0123456789abcdefghijklmnopqrstuvwxyzABCD",
  handoffSecret: "sec0123456789abcdefghijklmnopqrstuvwxyzABCD",
  claim: "claim0123456789abcdef",
};

const account: Account = {
  id: "0123456789abcdef0123456789abcdef",
  name: "Acme Studio",
  workersDevSubdomain: "acme",
};

const plan: Plan = {
  account,
  workerName: "appflare",
  hostname: "appflare.acme.example",
  address: "https://appflare.acme.example",
  choice: { kind: "domain", zone: "acme.example", subdomain: "appflare" },
};

const active: Active = {
  local: {
    installationId: "00000000-0000-4000-8000-000000000001",
    key: SAMPLE_SECRETS.key,
    handoffSecret: SAMPLE_SECRETS.handoffSecret,
    accountId: account.id,
  },
  accountName: account.name,
  workerName: "appflare",
  hostname: "appflare.acme.example",
  address: "https://appflare.acme.example",
  workersDevAddress: "https://appflare.acme.workers.dev",
  release: "0.4.2",
  remembered: true,
  notices: [],
};

const cronNotice: FinishedNote = {
  id: "schedules",
  label: "Schedule regular checks",
  message:
    "This account already uses every scheduled trigger its Workers plan allows, so Appflare's regular checks (such as looking for updates) do not run on their own. Appflare works; free a trigger in another Worker to turn them on.",
};

const unfinished: Unfinished = {
  id: active.local.installationId,
  workerName: "appflare",
  hostname: "appflare.acme.example",
  address: "https://appflare.acme.example",
  status: "running",
  step: { id: "assets", label: "Upload Appflare's files" },
  done: 3,
  total: 11,
  release: { version: "0.4.2" },
  createdAt: "2026-10-06T10:00:00.000Z",
  updatedAt: "2026-10-06T10:04:00.000Z",
};

const target: RemovalTarget = {
  id: active.local.installationId,
  key: SAMPLE_SECRETS.key,
  account,
  workerName: "appflare",
  hostname: "appflare.acme.example",
  address: "https://appflare.acme.example",
};

const deploying: Extract<DeployView, { step: "deploying" }> = {
  step: "deploying",
  active,
  progress: null,
  reconnecting: false,
  wait: null,
  offerWorkersDev: false,
  checking: false,
  checkedAt: null,
  notes: [],
};

const held: StepAnswer = {
  status: "waiting",
  step: { id: "workflow", label: "Set up background jobs" },
  done: 5,
  total: 11,
  retryAfterMs: 2000,
  message: "Another window is working on this installation.",
};

const proofWait: StepAnswer = {
  status: "waiting",
  step: { id: "proof", label: "Wait for Appflare to answer" },
  done: 10,
  total: 11,
  retryAfterMs: 5000,
  message: "Cloudflare is still putting Appflare live at the address.",
};

export const SAMPLE_VIEWS: Record<string, DeployView> = {
  loading: { step: "loading" },
  unavailable: { step: "unavailable", reason: "unregistered-origin" },
  welcome: { step: "welcome", unfinished: false, notice: null, busy: false, error: null },
  "welcome-resume": {
    step: "welcome",
    unfinished: true,
    notice: "reconnect",
    busy: false,
    error: null,
  },
  working: { step: "working", label: "Reading your Cloudflare accounts…" },
  account: {
    step: "account",
    accounts: [account, { id: "f".repeat(32), name: "Personal", workersDevSubdomain: null }],
    notice: null,
  },
  "account-unreachable": {
    step: "account",
    accounts: [account],
    notice: "account-unreachable",
  },
  unfinished: { step: "unfinished", account, mine: unfinished, others: [], notice: null },
  "unfinished-elsewhere": {
    step: "unfinished",
    account,
    mine: null,
    others: [
      {
        ...unfinished,
        id: "00000000-0000-4000-8000-000000000002",
        address: "https://team.acme.example",
      },
    ],
    notice: "finished-elsewhere",
  },
  name: { step: "name", account, value: "appflare", checking: false, error: null },
  "name-taken": {
    step: "name",
    account,
    value: "appflare",
    checking: false,
    error:
      'Something in this Cloudflare account already uses the name "appflare". Choose another name.',
  },
  "address-domain": {
    step: "address",
    account,
    workerName: "appflare",
    zones: [
      { id: "z1", name: "acme.example" },
      { id: "z2", name: "acme-shop.example" },
    ],
    choice: { kind: "domain", zone: "acme.example", subdomain: "appflare" },
    checking: false,
    error: null,
  },
  "address-conflict": {
    step: "address",
    account,
    workerName: "appflare",
    zones: [{ id: "z1", name: "acme.example" }],
    choice: { kind: "domain", zone: "acme.example", subdomain: "appflare" },
    checking: false,
    error:
      "appflare.acme.example already has a DNS record. Choose another subdomain, or remove the record in the Cloudflare dashboard first.",
  },
  "address-workers-dev": {
    step: "address",
    account,
    workerName: "appflare",
    zones: [],
    choice: { kind: "workers-dev" },
    checking: false,
    error: null,
  },
  "address-none": {
    step: "address",
    account: { ...account, workersDevSubdomain: null },
    workerName: "appflare",
    zones: [],
    choice: null,
    checking: false,
    error: null,
  },
  review: {
    step: "review",
    plan,
    release: "0.4.2",
    releaseError: null,
    starting: false,
    error: null,
  },
  "review-release-error": {
    step: "review",
    plan,
    release: null,
    releaseError:
      "GitHub, where Appflare's releases are stored, did not answer. Try again in a moment.",
    starting: false,
    error: null,
  },
  deploying: {
    ...deploying,
    progress: {
      status: "running",
      step: { id: "assets", label: "Upload Appflare's files" },
      done: 3,
      total: 11,
      message: "Uploaded 120 of 180 files.",
    },
    notes: [
      {
        id: "database",
        label: "Create the database",
        message: 'Created the D1 database "appflare".',
      },
      {
        id: "storage",
        label: "Create the key-value storage",
        message: 'Created the KV namespace "appflare-kv".',
      },
    ],
  },
  "deploying-reconnecting": {
    ...deploying,
    active: { ...active, remembered: false },
    progress: {
      status: "running",
      step: { id: "worker", label: "Upload Appflare" },
      done: 4,
      total: 11,
    },
    reconnecting: true,
  },
  /** Another tab holds the installation: shown as the step still working. */
  "deploying-held": { ...deploying, progress: held, wait: "quiet" },
  /** The same, well past the hold: one line and Check now. */
  "deploying-held-long": { ...deploying, progress: held, wait: "long" },
  "deploying-held-checking": { ...deploying, progress: held, wait: "long", checking: true },
  "deploying-address": { ...deploying, progress: proofWait, wait: "address" },
  "deploying-address-checking": {
    ...deploying,
    progress: proofWait,
    wait: "address",
    checking: true,
  },
  "deploying-address-checked": {
    ...deploying,
    progress: proofWait,
    wait: "address",
    checkedAt: Date.UTC(2026, 9, 6, 19, 32),
  },
  /** Past the offer: the workers.dev address, in one line. */
  "deploying-waiting": {
    ...deploying,
    progress: proofWait,
    wait: "address",
    offerWorkersDev: true,
  },
  "deploy-failed": {
    step: "deploy-failed",
    active,
    progress: {
      status: "failed",
      step: { id: "domain", label: "Connect your domain" },
      done: 9,
      total: 11,
    },
    message:
      "Cloudflare did not let this sign-in connect your domain. Connect your Cloudflare account again with every permission Appflare asks for, then continue.",
  },
  "handing-off": { step: "handing-off", active, address: active.address },
  "handing-off-notice": {
    step: "handing-off",
    active: { ...active, notices: [cronNotice] },
    address: active.address,
  },
  "handoff-failed": {
    step: "handoff-failed",
    active,
    address: active.address,
    problem: "unverified",
  },
  opening: {
    step: "opening",
    address: active.address,
    ownerSetupUrl: `${active.address}/setup#claim=${SAMPLE_SECRETS.claim}`,
    notices: [],
  },
  /** The account had no scheduled trigger left: said once more before owner setup. */
  "opening-notice": {
    step: "opening",
    address: active.address,
    ownerSetupUrl: `${active.address}/setup#claim=${SAMPLE_SECRETS.claim}`,
    notices: [cronNotice],
  },
  "set-up": { step: "set-up", address: active.address, notices: [] },
  "confirm-remove": { step: "confirm-remove", target, back: { step: "loading" } },
  removing: {
    step: "removing",
    target,
    progress: {
      status: "running",
      step: { id: "worker", label: "Remove the Appflare Worker" },
      done: 2,
      total: 6,
    },
    error: null,
  },
  removed: { step: "removed", target },
  error: {
    step: "error",
    message: "Appflare's installer did not answer. Check your connection; this page tries again.",
    retry: "accounts",
  },
};

export const SAMPLE_CALLBACK_VIEWS: Record<string, CallbackView> = {
  "callback-working": { step: "working" },
  "callback-confirm-return": {
    step: "confirm-return",
    origin: "https://appflare.acme.example",
    fields: { code: SAMPLE_SECRETS.claim, state: "state0123" },
  },
  "callback-returning": { step: "returning", origin: "https://appflare.acme.example" },
  "callback-cancelled": { step: "cancelled" },
  "callback-declined": { step: "declined" },
  "callback-unknown-session": { step: "problem", problem: "unknown-session" },
  "callback-missing-scopes": {
    step: "problem",
    problem: { kind: "missing-scopes", missing: ["dns.write", "zone.read"] },
  },
};
