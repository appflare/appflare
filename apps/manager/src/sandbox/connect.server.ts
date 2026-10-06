import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import { SANDBOX_ENTRYPOINT, SANDBOX_WORKER_NAME, type SandboxInfo } from "@appflare/schema";
import { settingsPlace } from "../components/settings-links";
import { createDb } from "../db/client";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { MANAGER_SUBDOMAIN } from "../installs/workers-dev";
import { probeHealth } from "../jobs/install/health";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import { refuseDuringSelfUpdate } from "../jobs/self-update/guard";
import { classifyManagerCanary } from "../jobs/self-update/plan";
import { activeVersionId, previewUrl } from "../jobs/update/plan";
import {
  SANDBOX_BINDING,
  type SandboxBuildsBinding,
  SandboxProtocolError,
  sandboxBindingKind,
  sandboxInfo,
} from "./binding";
import { ENABLE_SANDBOX_PLACE } from "./connect-copy";

/**
 * Settings, Building apps: whether this manager can build sandbox tier apps,
 * and connecting it to the sandbox Worker (or disconnecting it).
 *
 * Connected means the running Worker has its `SANDBOX` service binding; that
 * binding is the only record (no setting that could disagree with it). The
 * sandbox Worker itself is deployed by the "Enable sandbox builds" job
 * (./enable-job.ts), because it needs Containers, which only Workers Paid
 * accounts have.
 *
 * Changing the binding does not re-upload the manager: a new version is made
 * from the latest one with `PATCH /workers/workers/<name>/versions/latest`
 * (a JSON merge patch that only adds `SANDBOX` to its bindings, or removes it
 * with `null`; code, assets, secrets and every other binding are inherited),
 * its preview must answer `/api/health` like the running version, and only
 * then is it deployed to all traffic. The same version-then-check-then-deploy
 * order a self-update uses, on the free plan too. Appflare's next self-update
 * keeps the binding as long as the sandbox Worker exists.
 *
 * Whether the binding is there is read from the version that serves (its id
 * from the deployments, its bindings from that version), never from
 * `/workers/scripts/<name>/bindings`: that shows the newest uploaded version,
 * which after a failed preview check has the binding while the serving one
 * does not.
 *
 * A `SANDBOX` binding to a deleted Worker, which deleting the sandbox Worker
 * leaves behind (see `sandboxBindingKind`), counts as Appflare's own:
 * connecting replaces it, disconnecting removes it, and the status reads
 * sandbox builds as off.
 */

export class SandboxConnectError extends Error {
  override name = "SandboxConnectError";
}

export interface SandboxStatus {
  /**
   * The running Worker has its `SANDBOX` binding to the sandbox Worker. One
   * to a deleted Worker does not count (see `danglingBinding`).
   */
  connected: boolean;
  /** What the sandbox Worker says about itself, when connected and answering. */
  info: SandboxInfo | null;
  /** Why a connected sandbox Worker cannot be used; null when it can (or is not connected). */
  problem: string | null;
  /**
   * Whether the account has a Worker named `appflare-sandbox`: checked for
   * admins when not connected (it decides whether "Connect" is offered);
   * null otherwise.
   */
  workerExists: boolean | null;
  /**
   * The running Worker still has a `SANDBOX` binding, to a Worker that was
   * deleted (a disable that stopped before its last step leaves one):
   * checked for every signed-in user when the binding does not answer. Sandbox builds are
   * off; disabling them removes the binding, enabling them replaces it.
   */
  danglingBinding: boolean;
}

export async function readSandboxStatus(deps: {
  binding: SandboxBuildsBinding | undefined;
  /** Worker names in the account; omitted for members. */
  listWorkers?: () => Promise<string[]>;
  /** Whether the serving version's `SANDBOX` binding points at a deleted Worker. */
  bindingDangles?: () => Promise<boolean>;
}): Promise<SandboxStatus> {
  const off = async (danglingBinding: boolean): Promise<SandboxStatus> => {
    let workerExists: boolean | null = null;
    if (deps.listWorkers !== undefined) {
      try {
        workerExists = (await deps.listWorkers()).includes(SANDBOX_WORKER_NAME);
      } catch {
        workerExists = null;
      }
    }
    return { connected: false, info: null, problem: null, workerExists, danglingBinding };
  };
  if (deps.binding === undefined) return off(false);
  let problem: string;
  try {
    return {
      connected: true,
      info: await sandboxInfo(deps.binding),
      problem: null,
      workerExists: null,
      danglingBinding: false,
    };
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
    // It answered, so the Worker it names is there.
    if (error instanceof SandboxProtocolError) {
      return { connected: true, info: null, problem, workerExists: null, danglingBinding: false };
    }
  }
  // A call through a binding to a deleted Worker fails like one the sandbox
  // Worker does not answer ("Network connection lost."); only the bindings
  // Cloudflare reports tell them apart.
  let dangles = false;
  try {
    dangles = (await deps.bindingDangles?.()) === true;
  } catch {
    dangles = false;
  }
  if (dangles) return off(true);
  return { connected: true, info: null, problem, workerExists: null, danglingBinding: false };
}

/** What changing the binding needs; no database, so a job unit can run it too. */
export interface SandboxBindingDeps {
  client: CloudflareClient;
  /** The manager's own Worker. */
  workerName: string;
  /** The account's workers.dev subdomain, when known; looked up (and reported) otherwise. */
  subdomain: string | null;
  onSubdomain?: (subdomain: string) => Promise<void>;
  /** The running Appflare version (`runningVersion`): the new version must report the same. */
  currentVersion: string;
  /** For the preview probes. */
  fetch: FetchLike;
  sleep(ms: number): Promise<void>;
}

export interface SandboxBindingResult {
  /** The serving version already was as asked; nothing was changed. */
  unchanged: boolean;
  /** The version that now serves all traffic; null when nothing changed. */
  versionId: string | null;
}

export interface ConnectSandboxDeps {
  db: D1Database;
  client: CloudflareClient;
  /** The running Appflare version (`runningVersion`): the new version must report the same. */
  currentVersion: string;
  /** For the preview probes. */
  fetch: FetchLike;
  sleep(ms: number): Promise<void>;
  workflows?: WorkflowLookup;
  now?: () => Date;
}

export interface ConnectSandboxResult {
  /** The Worker already had the binding; nothing was changed. */
  alreadyConnected: boolean;
  /** The version that now serves all traffic with the binding; null when nothing changed. */
  versionId: string | null;
}

/** Preview probes before connecting gives up (2 seconds apart). */
export const CONNECT_PROBE_ATTEMPTS = 8;
const PROBE_DELAY_MS = 2000;

/** The message of every version a connect attempt creates; never change it. */
export const CONNECT_MESSAGE = "Appflare: connect sandbox builds";
/** The message of every version a disconnect attempt creates; never change it. */
export const DISCONNECT_MESSAGE = "Appflare: disconnect sandbox builds";

/**
 * Whether `version` is an earlier connect (or disconnect) attempt made from
 * the version that serves: made by this action (its message) from `serving`
 * (its tag). Its preview check failed, so it never served; Cloudflare cannot
 * delete versions, so without this a failed attempt would block every retry.
 */
export function isConnectAttempt(
  version: { annotations?: Record<string, string> },
  serving: string,
): boolean {
  const message = version.annotations?.["workers/message"];
  return (
    (message === CONNECT_MESSAGE || message === DISCONNECT_MESSAGE) &&
    version.annotations?.["workers/tag"] === serving
  );
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** The `SANDBOX` binding of a version's bindings, if any. */
function sandboxBindingOf(bindings: unknown): Record<string, unknown> | null {
  if (!Array.isArray(bindings)) return null;
  for (const raw of bindings) {
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw as Record<string, unknown>;
    if (b.name === SANDBOX_BINDING) return b;
  }
  return null;
}

/**
 * The version that serves all of `workerName`'s traffic and its `SANDBOX`
 * binding (null when it has none); null when no single version serves it
 * all (a gradual deployment).
 */
async function servingSandboxBinding(
  api: CloudflareClient,
  workerName: string,
): Promise<{ serving: string; binding: Record<string, unknown> | null } | null> {
  const serving = activeVersionId(await api.versions.listDeployments(workerName));
  if (serving === null) return null;
  const version = await api.versions.getVersion(workerName, serving);
  return { serving, binding: sandboxBindingOf(version.resources?.bindings) };
}

/** Whether the version of Appflare's Worker that serves binds `SANDBOX` to a deleted Worker. */
export async function sandboxBindingDangles(
  api: CloudflareClient,
  workerName: string,
): Promise<boolean> {
  const found = await servingSandboxBinding(api, workerName);
  return found?.binding != null && sandboxBindingKind(found.binding) === "dangling";
}

/**
 * The read-only part of {@link changeSandboxBinding}: the version that serves
 * all of Appflare's traffic, when its `SANDBOX` binding has to change, or
 * null when it already is as asked. Throws `SandboxConnectError` for what
 * would stop the change (no single version serving, someone else's
 * `SANDBOX` when connecting, a newer upload the change would deploy too).
 * The disable job runs it before it deletes anything, so a disable that
 * could not disconnect at its end is refused while nothing is gone yet.
 */
export async function planSandboxBindingChange(
  api: CloudflareClient,
  workerName: string,
  connect: boolean,
): Promise<{ serving: string } | null> {
  const fail = (message: string) => new SandboxConnectError(message);
  const found = await servingSandboxBinding(api, workerName);
  if (found === null) {
    throw fail(
      "No single version serves all of Appflare's traffic (a gradual deployment is in progress). Finish or undo it in the Cloudflare dashboard first.",
    );
  }
  const { serving, binding: current } = found;
  const kind = current === null ? null : sandboxBindingKind(current);
  if (connect && kind === "ours") return null;
  if (connect && current !== null && kind === "foreign") {
    throw fail(
      `Appflare's Worker already has a ${String(current.type)} binding named ${SANDBOX_BINDING}${current.type === "service" ? ` to "${text(current.service) ?? "(no service)"}"` : ""}. Remove or rename it first.`,
    );
  }
  // Nothing to remove, or a binding by that name that is not Appflare's own.
  // One to a deleted Worker is replaced by connecting and removed by
  // disconnecting, like Appflare's own.
  const removable = kind === "ours" || kind === "dangling";
  if (!connect && !removable) return null;

  // The new version is made from the latest uploaded one, so that one must be
  // what serves, or an earlier attempt made from it. Otherwise this would
  // also deploy someone's unreleased code.
  const versions = await api.versions.listVersions(workerName);
  const latest = [...versions].sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0];
  if (latest === undefined || (latest.id !== serving && !isConnectAttempt(latest, serving))) {
    throw fail(
      `The newest uploaded version of Appflare's Worker (${latest?.id ?? "unknown"}) is not the one serving (${serving}), and ${connect ? "connecting" : "disconnecting"} would deploy it too. If it is a version you want, deploy it from the Worker's Deployments page in the Cloudflare dashboard; otherwise update Appflare in ${settingsPlace("updates", "appflare", "the Updates settings")}, which uploads and deploys a new version. Then try again.`,
    );
  }
  return { serving };
}

/**
 * Adds (`connect`) or removes the manager's `SANDBOX` binding, as described
 * in the module comment. Throws `SandboxConnectError` with what to do.
 */
export async function changeSandboxBinding(
  deps: SandboxBindingDeps,
  connect: boolean,
): Promise<SandboxBindingResult> {
  const fail = (message: string) => new SandboxConnectError(message);
  const api = deps.client;
  const { workerName } = deps;

  if (connect) {
    const scripts = await api.workers.listScripts();
    if (!scripts.some((s) => s.id === SANDBOX_WORKER_NAME)) {
      throw fail(
        `There is no sandbox Worker ("${SANDBOX_WORKER_NAME}") in this account. Enable sandbox builds in ${ENABLE_SANDBOX_PLACE} first; it needs Workers Paid.`,
      );
    }
  }

  const planned = await planSandboxBindingChange(api, workerName, connect);
  if (planned === null) return { unchanged: true, versionId: null };
  const { serving } = planned;

  const message = connect ? CONNECT_MESSAGE : DISCONNECT_MESSAGE;
  const created = await api.versions.patchLatestVersion(workerName, {
    env: {
      [SANDBOX_BINDING]: connect
        ? { type: "service", service: SANDBOX_WORKER_NAME, entrypoint: SANDBOX_ENTRYPOINT }
        : null,
    },
    annotations: {
      "workers/message": message,
      // The version it was made from: a retry recognises this attempt by it.
      "workers/tag": serving,
    },
  });

  let subdomain = deps.subdomain;
  if (!subdomain) {
    subdomain = (await api.workers.getAccountSubdomain()).subdomain;
    await deps.onSubdomain?.(subdomain);
  }
  // Appflare keeps its own workers.dev URL (see MANAGER_SUBDOMAIN).
  await api.workers.enableSubdomain(workerName, MANAGER_SUBDOMAIN);

  const url = previewUrl(created.id, workerName, subdomain, "/api/health");
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    const probe = await probeHealth(deps.fetch, url);
    const verdict = classifyManagerCanary(
      probe,
      deps.currentVersion,
      attempt,
      Date.now() - started,
      CONNECT_PROBE_ATTEMPTS,
    );
    if (verdict.verdict === "healthy") break;
    if (verdict.verdict === "unhealthy" || attempt >= CONNECT_PROBE_ATTEMPTS) {
      throw fail(
        `The new version ${created.id} did not pass its check (${verdict.reason}), so it was not deployed; Appflare keeps running ${connect ? "without" : "with"} its sandbox binding. Try again.`,
      );
    }
    await deps.sleep(PROBE_DELAY_MS);
  }

  await api.versions.createDeployment(workerName, {
    versions: [{ version_id: created.id, percentage: 100 }],
    annotations: { "workers/message": message },
  });
  return { unchanged: false, versionId: created.id };
}

/** "Connect sandbox builds" from Settings: the checks around {@link changeSandboxBinding}. */
export async function connectSandboxCore(deps: ConnectSandboxDeps): Promise<ConnectSandboxResult> {
  await refuseDuringSelfUpdate(deps.db, deps.workflows, (m) => new SandboxConnectError(m));
  const orm = createDb(deps.db);
  const settings = await readSettings(orm, [SETTING.workerName, SETTING.accountSubdomain]);
  const workerName = settings.worker_name;
  if (!workerName) {
    throw new SandboxConnectError("Appflare does not know its own Worker yet. Finish setup first.");
  }
  const result = await changeSandboxBinding(
    {
      client: deps.client,
      workerName,
      subdomain: settings.account_subdomain ?? null,
      onSubdomain: async (subdomain) => {
        await writeSettings(
          orm,
          { [SETTING.accountSubdomain]: subdomain },
          (deps.now ?? (() => new Date()))(),
        );
      },
      currentVersion: deps.currentVersion,
      fetch: deps.fetch,
      sleep: deps.sleep,
    },
    true,
  );
  return { alreadyConnected: result.unchanged, versionId: result.versionId };
}
