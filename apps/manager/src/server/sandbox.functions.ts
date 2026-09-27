import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { hasRole } from "../auth/roles";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { sandboxBinding } from "../sandbox/binding";
import { installsNeedingSandbox } from "../sandbox/blockers";
import {
  type ConnectSandboxResult,
  connectSandboxCore,
  readSandboxStatus,
  SandboxConnectError,
  type SandboxStatus,
} from "../sandbox/connect.server";
import {
  activeSandboxWorkerJob,
  lastSandboxJobFailure,
  SandboxJobError,
  type SandboxJobFailure,
  startSandboxJobCore,
} from "../sandbox/jobs.server";
import type { SandboxReadiness } from "../sandbox/readiness";
import { readSandboxReadiness } from "../sandbox/readiness.server";
import { PINNED_SANDBOX_VERSION, sandboxUpdateAvailable } from "../sandbox/release";
import { requireRole, requireSession } from "./auth.server";

export type { SandboxStatus } from "../sandbox/connect.server";

/**
 * Settings, Building apps. Reading the state is open to every signed-in
 * user (admins also learn whether the sandbox Worker exists, which costs one
 * API call); enabling, updating, disabling and connecting are admin only.
 */

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

export const getSandboxStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<SandboxCardState> => {
    const session = await requireSession();
    const admin = hasRole(session.user.role, "admin");
    const status = await readSandboxStatus({
      binding: sandboxBinding(env),
      ...(admin
        ? {
            listWorkers: async () =>
              (await (await getCfClient(env)).workers.listScripts()).map((s) => s.id),
          }
        : {}),
    });
    const [activeJob, lastFailure, inUse, readiness] = await Promise.all([
      activeSandboxWorkerJob(env.DB),
      lastSandboxJobFailure(env.DB),
      installsNeedingSandbox(createDb(env.DB)),
      readSandboxReadiness(env, createDb(env.DB)),
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
  },
);

/**
 * The sandbox builds row's state on Your account: `on`, `ready-auto` (turned on
 * by the first install or build that needs it), or what is missing
 * (`needs-plan`, `needs-permission`, `needs-r2`). Any signed-in user; no
 * Cloudflare API call. Turning them on by hand (Building apps) is {@link startSandboxJob} with
 * `action: "enable"`.
 */
export const getSandboxReadiness = createServerFn({ method: "GET" }).handler(
  async (): Promise<SandboxReadiness> => {
    await requireSession();
    return readSandboxReadiness(env, createDb(env.DB));
  },
);

/** The messages a refused start or connect shows as they are; anything else stays generic. */
function explained(error: unknown): never {
  if (
    error instanceof SandboxConnectError ||
    error instanceof SandboxJobError ||
    error instanceof CloudflareApiError ||
    error instanceof CfTokenNotConfiguredError
  ) {
    throw new Error(error.message);
  }
  throw error;
}

export const connectSandbox = createServerFn({ method: "POST" }).handler(
  async (): Promise<ConnectSandboxResult> => {
    await requireRole("admin");
    try {
      return await connectSandboxCore({
        db: env.DB,
        client: await getCfClient(env),
        currentVersion: env.APPFLARE_VERSION,
        fetch: (input, init) => fetch(input, init),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        workflows: env.JOBS,
      });
    } catch (error) {
      explained(error);
    }
  },
);

/**
 * Admin only: starts "Enable sandbox builds", "Update sandbox" or "Disable
 * sandbox builds" (which needs the sandbox Worker's name typed). Returns the
 * job id for `/jobs/$jobId`.
 */
export const startSandboxJob = createServerFn({ method: "POST" })
  .validator(
    z.object({
      action: z.enum(["enable", "update", "disable"]),
      confirm: z.string().max(64).optional(),
    }),
  )
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    await requireRole("admin");
    try {
      return await startSandboxJobCore(
        {
          db: env.DB,
          client: () => getCfClient(env),
          workflows: env.JOBS,
          createJob: (id, params) => env.JOBS.create({ id, params }),
          currentVersion: env.APPFLARE_VERSION,
          deployedSandboxVersion: await deployedSandboxVersion(),
        },
        data,
      );
    } catch (error) {
      explained(error);
    }
  });

/** What the connected sandbox Worker reports, or null (not connected, or not answering). */
async function deployedSandboxVersion(): Promise<string | null> {
  const status = await readSandboxStatus({ binding: sandboxBinding(env) });
  return status.info?.sandboxVersion ?? null;
}
