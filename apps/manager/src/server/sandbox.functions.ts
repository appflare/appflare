import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { hasRole } from "../auth/roles";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { jobCreator } from "../jobs/create-job.server";
import { sandboxBinding } from "../sandbox/binding";
import { readSandboxCardState, type SandboxCardState } from "../sandbox/card-state.server";
import {
  type ConnectSandboxResult,
  connectSandboxCore,
  readSandboxStatus,
  SandboxConnectError,
} from "../sandbox/connect.server";
import { SandboxJobError, startSandboxJobCore } from "../sandbox/jobs.server";
import type { SandboxReadiness } from "../sandbox/readiness";
import { readSandboxReadiness } from "../sandbox/readiness.server";
import { requireRole, requireSession } from "./auth.server";
import { runningVersion } from "./build-version";

export type { SandboxCardState } from "../sandbox/card-state.server";
export type { SandboxStatus } from "../sandbox/connect.server";

/**
 * Settings, Building apps. Reading the state is open to every signed-in
 * user. When the binding does not answer, telling whether it points at a
 * deleted Worker costs two API calls; with sandbox builds off, admins also
 * learn whether the sandbox Worker exists, which costs one. Enabling,
 * updating, disabling and connecting are admin only.
 */

export const getSandboxStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<SandboxCardState> => {
    const session = await requireSession();
    return readSandboxCardState(env, {
      admin: hasRole(session.user.role, "admin"),
      client: () => getCfClient(env),
    });
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
        currentVersion: runningVersion(env),
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
          createJob: jobCreator(env.JOBS),
          currentVersion: runningVersion(env),
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
