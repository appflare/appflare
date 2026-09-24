import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import { SANDBOX_ENTRYPOINT, SANDBOX_WORKER_NAME, type SandboxInfo } from "@appflare/schema";
import { createDb } from "../db/client";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { MANAGER_SUBDOMAIN } from "../installs/workers-dev";
import { probeHealth } from "../jobs/install/health";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import { refuseDuringSelfUpdate } from "../jobs/self-update/guard";
import { classifyManagerCanary } from "../jobs/self-update/plan";
import { activeVersionId, previewUrl } from "../jobs/update/plan";
import { SANDBOX_BINDING, type SandboxBuildsBinding, sandboxInfo } from "./binding";
import { ENABLE_SANDBOX_COMMAND } from "./connect-copy";

/**
 * Settings, Sandbox builds: whether this manager can build sandbox tier apps,
 * and connecting it to the sandbox Worker.
 *
 * Connected means the running Worker has its `SANDBOX` service binding; that
 * binding is the only record (no setting that could disagree with it). The
 * sandbox Worker itself is deployed by the CLI (`appflare sandbox enable`),
 * because it needs Containers, which only Workers Paid accounts have.
 *
 * Connecting adds the binding without re-uploading the manager: a new
 * version is made from the latest one with `PATCH
 * /workers/workers/<name>/versions/latest` (a JSON merge patch that only
 * adds `SANDBOX` to its bindings; code, assets, secrets and every other
 * binding are inherited), its preview must answer `/api/health` like the
 * running version, and only then is it deployed to all traffic. The same
 * version-then-check-then-deploy order a self-update uses, on the free plan
 * too. Appflare's next self-update keeps the binding as long as the sandbox
 * Worker exists.
 */

export class SandboxConnectError extends Error {
  override name = "SandboxConnectError";
}

export { ENABLE_SANDBOX_COMMAND };

export interface SandboxStatus {
  /** The running Worker has the `SANDBOX` binding. */
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
}

export async function readSandboxStatus(deps: {
  binding: SandboxBuildsBinding | undefined;
  /** Worker names in the account; omitted for members. */
  listWorkers?: () => Promise<string[]>;
}): Promise<SandboxStatus> {
  if (deps.binding !== undefined) {
    try {
      return {
        connected: true,
        info: await sandboxInfo(deps.binding),
        problem: null,
        workerExists: null,
      };
    } catch (error) {
      return {
        connected: true,
        info: null,
        problem: error instanceof Error ? error.message : String(error),
        workerExists: null,
      };
    }
  }
  let workerExists: boolean | null = null;
  if (deps.listWorkers !== undefined) {
    try {
      workerExists = (await deps.listWorkers()).includes(SANDBOX_WORKER_NAME);
    } catch {
      workerExists = null;
    }
  }
  return { connected: false, info: null, problem: null, workerExists };
}

export interface ConnectSandboxDeps {
  db: D1Database;
  client: CloudflareClient;
  /** The running `APPFLARE_VERSION`: the new version must report the same. */
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

/**
 * Whether `version` is an earlier connect attempt made from the version that
 * serves: made by this action (its message) from `serving` (its tag).
 */
export function isConnectAttempt(
  version: { annotations?: Record<string, string> },
  serving: string,
): boolean {
  return (
    version.annotations?.["workers/message"] === CONNECT_MESSAGE &&
    version.annotations["workers/tag"] === serving
  );
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export async function connectSandboxCore(deps: ConnectSandboxDeps): Promise<ConnectSandboxResult> {
  const fail = (message: string) => new SandboxConnectError(message);
  await refuseDuringSelfUpdate(deps.db, deps.workflows, fail);
  const orm = createDb(deps.db);
  const settings = await readSettings(orm, [SETTING.workerName, SETTING.accountSubdomain]);
  const workerName = settings.worker_name;
  if (!workerName) {
    throw fail("Appflare does not know its own Worker yet. Finish setup first.");
  }
  const api = deps.client;

  const scripts = await api.workers.listScripts();
  if (!scripts.some((s) => s.id === SANDBOX_WORKER_NAME)) {
    throw fail(
      `There is no sandbox Worker ("${SANDBOX_WORKER_NAME}") in this account. Enable sandbox builds with \`${ENABLE_SANDBOX_COMMAND}\` first; it needs Workers Paid.`,
    );
  }

  const bindings = await api.workers.getBindings(workerName);
  for (const raw of bindings) {
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw as Record<string, unknown>;
    if (b.name !== SANDBOX_BINDING) continue;
    if (b.type === "service" && text(b.service) === SANDBOX_WORKER_NAME) {
      return { alreadyConnected: true, versionId: null };
    }
    throw fail(
      `Appflare's Worker already has a ${String(b.type)} binding named ${SANDBOX_BINDING}${b.type === "service" ? ` to "${text(b.service) ?? "(no service)"}"` : ""}. Remove or rename it first.`,
    );
  }

  // The new version is made from the latest uploaded one, so that one must be
  // what serves, or an earlier connect attempt made from it (its preview check
  // failed, so it never served; Cloudflare cannot delete versions, so without
  // this a failed attempt would block every retry). Otherwise connecting would
  // also deploy someone's unreleased code.
  const serving = activeVersionId(await api.versions.listDeployments(workerName));
  if (serving === null) {
    throw fail(
      "No single version serves all of Appflare's traffic (a gradual deployment is in progress). Finish or undo it in the Cloudflare dashboard first.",
    );
  }
  const versions = await api.versions.listVersions(workerName);
  const latest = [...versions].sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0];
  if (latest === undefined || (latest.id !== serving && !isConnectAttempt(latest, serving))) {
    throw fail(
      `The newest uploaded version of Appflare's Worker (${latest?.id ?? "unknown"}) is not the one serving (${serving}), and connecting would deploy it too. If it is a version you want, deploy it from the Worker's Deployments page in the Cloudflare dashboard; otherwise update Appflare in Settings, which uploads and deploys a new version. Then connect again.`,
    );
  }

  const created = await api.versions.patchLatestVersion(workerName, {
    env: {
      [SANDBOX_BINDING]: {
        type: "service",
        service: SANDBOX_WORKER_NAME,
        entrypoint: SANDBOX_ENTRYPOINT,
      },
    },
    annotations: {
      "workers/message": CONNECT_MESSAGE,
      // The version it was made from: a retry recognises this attempt by it.
      "workers/tag": serving,
    },
  });

  let subdomain = settings.account_subdomain;
  if (!subdomain) {
    subdomain = (await api.workers.getAccountSubdomain()).subdomain;
    await writeSettings(
      orm,
      { [SETTING.accountSubdomain]: subdomain },
      (deps.now ?? (() => new Date()))(),
    );
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
        `The new version ${created.id} did not pass its check (${verdict.reason}), so it was not deployed; Appflare keeps running without sandbox builds.`,
      );
    }
    await deps.sleep(PROBE_DELAY_MS);
  }

  await api.versions.createDeployment(workerName, {
    versions: [{ version_id: created.id, percentage: 100 }],
    annotations: { "workers/message": CONNECT_MESSAGE },
  });
  return { alreadyConnected: false, versionId: created.id };
}
