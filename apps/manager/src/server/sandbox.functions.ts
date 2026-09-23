import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { createServerFn } from "@tanstack/react-start";
import { hasRole } from "../auth/roles";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { sandboxBinding } from "../sandbox/binding";
import {
  type ConnectSandboxResult,
  connectSandboxCore,
  readSandboxStatus,
  SandboxConnectError,
  type SandboxStatus,
} from "../sandbox/connect.server";
import { requireRole, requireSession } from "./auth.server";

export type { SandboxStatus } from "../sandbox/connect.server";

/**
 * Settings, Sandbox builds. Reading the state is open to every signed-in
 * user (admins also learn whether the sandbox Worker exists, which costs one
 * API call); connecting is admin only.
 */

export const getSandboxStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<SandboxStatus> => {
    const session = await requireSession();
    const admin = hasRole(session.user.role, "admin");
    return readSandboxStatus({
      binding: sandboxBinding(env),
      ...(admin
        ? {
            listWorkers: async () =>
              (await (await getCfClient(env)).workers.listScripts()).map((s) => s.id),
          }
        : {}),
    });
  },
);

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
      if (
        error instanceof SandboxConnectError ||
        error instanceof CloudflareApiError ||
        error instanceof CfTokenNotConfiguredError
      ) {
        throw new Error(error.message);
      }
      throw error;
    }
  },
);
