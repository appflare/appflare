import type { CloudflareClient } from "@appflare/cf-api";
import type { CfClientEnv } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { sandboxBinding } from "./binding";
import { installsNeedingSandbox } from "./blockers";
import { readSandboxStatus, type SandboxStatus } from "./connect.server";
import { bindingDanglesWith } from "./connection.server";
import {
  activeSandboxWorkerJob,
  lastSandboxJobFailure,
  type SandboxJobFailure,
} from "./jobs.server";
import type { SandboxReadiness } from "./readiness";
import { readSandboxReadiness } from "./readiness.server";
import { PINNED_SANDBOX_VERSION, sandboxUpdateAvailable } from "./release";
import { recordSandboxCheck } from "./worker-deleted";

export interface SandboxCardState extends SandboxStatus {
  /** The sandbox Worker release this Appflare deploys. */
  pinnedVersion: string;
  /** The connected sandbox Worker is older than {@link SandboxCardState.pinnedVersion}. */
  updateAvailable: boolean;
  /** An enable, update or disable job that is queued or running. */
  activeJob: { id: string; kind: string } | null;
  /** The most recent enable, update or disable job, when it failed and no newer one succeeded. */
  lastFailure: SandboxJobFailure | null;
  /** Apps that need the sandbox Worker, which keep it from being disabled. */
  inUseBy: string[];
  /** On, ready to turn on at first need, or what is missing. */
  readiness: SandboxReadiness;
}

/**
 * Settings, Building apps: the live state of the binding, the sandbox jobs,
 * the apps that need the sandbox Worker, and the readiness the other pages
 * show. Admins also learn whether the sandbox Worker exists.
 */
export async function readSandboxCardState(
  env: CfClientEnv & { SANDBOX?: unknown },
  opts: { admin: boolean; client: () => Promise<CloudflareClient> },
): Promise<SandboxCardState> {
  const db = createDb(env.DB);
  const status = await readSandboxStatus({
    binding: sandboxBinding(env),
    bindingDangles: bindingDanglesWith(env.DB, opts.client),
    ...(opts.admin
      ? {
          listWorkers: async () =>
            (await (await opts.client()).workers.listScripts()).map((s) => s.id),
        }
      : {}),
  });
  // Before the readiness below reads it.
  await recordSandboxCheck(db, status);
  const [activeJob, lastFailure, inUse, readiness] = await Promise.all([
    activeSandboxWorkerJob(env.DB),
    lastSandboxJobFailure(env.DB),
    installsNeedingSandbox(db),
    readSandboxReadiness(env, db),
  ]);
  return {
    ...status,
    pinnedVersion: PINNED_SANDBOX_VERSION,
    updateAvailable: sandboxUpdateAvailable(status.info?.sandboxVersion),
    activeJob,
    lastFailure,
    inUseBy: inUse.map((i) => i.label),
    readiness,
  };
}
