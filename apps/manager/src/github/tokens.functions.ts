import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { SANDBOX_WORKER_NAME } from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { hasRole } from "../auth/roles";
import { getCfClient } from "../cloudflare/client.server";
import { usesGithubTokens } from "../sandbox/binding";
import { requireRole, requireSession } from "../server/auth.server";
import { addGithubTokenInput, type GithubTokenView, githubTokenIdInput } from "./tokens";
import {
  addGithubTokenCore,
  deleteGithubTokenCore,
  type GithubTokenDeps,
  GithubTokenError,
  githubSandboxState,
  githubTokenViews,
  readGithubTokens,
} from "./tokens.server";

/**
 * Settings, GitHub access: admin only. Admins see the list (labels,
 * repositories, last use; never a value) and add and delete tokens; other
 * users get nothing about them.
 */

const sandboxState = () => githubSandboxState(env);

function tokenDeps(): GithubTokenDeps {
  return {
    db: env.DB,
    sandbox: sandboxState,
    async putSandboxSecret(name, value) {
      const api = await getCfClient(env);
      await api.workers.putSecret(SANDBOX_WORKER_NAME, { name, text: value });
    },
    async deleteSandboxSecret(name) {
      const api = await getCfClient(env);
      try {
        await api.workers.deleteSecret(SANDBOX_WORKER_NAME, name);
      } catch (error) {
        // Already gone (the sandbox Worker was replaced): nothing to delete.
        if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
      }
    },
  };
}

function asUserError(error: unknown): never {
  if (error instanceof GithubTokenError) throw new Error(error.message);
  throw error;
}

export interface GithubAccessState {
  tokens: GithubTokenView[];
  /** Sandbox builds are on: tokens can be added. */
  sandboxConnected: boolean;
  /**
   * The connected sandbox Worker uses GitHub access tokens; false when it
   * must be updated first, null when it did not answer or is not connected.
   */
  sandboxSupportsTokens: boolean | null;
}

/** Admins get the list; any other signed-in user gets null (the card stays hidden). */
export const getGithubAccess = createServerFn({ method: "GET" }).handler(
  async (): Promise<GithubAccessState | null> => {
    const session = await requireSession();
    if (!hasRole(session.user.role, "admin")) return null;
    const [records, sandbox] = await Promise.all([readGithubTokens(env.DB), sandboxState()]);
    return {
      tokens: githubTokenViews(records),
      sandboxConnected: sandbox.connected,
      sandboxSupportsTokens: sandbox.info === null ? null : usesGithubTokens(sandbox.info),
    };
  },
);

/** Admin only. Stores the token on the sandbox Worker and records it; the value is never returned. */
export const addGithubToken = createServerFn({ method: "POST" })
  .validator(addGithubTokenInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    await requireRole("admin");
    try {
      return await addGithubTokenCore(tokenDeps(), data);
    } catch (error) {
      asUserError(error);
    }
  });

/** Admin only. Deletes the token's secret from the sandbox Worker, then its record. */
export const deleteGithubToken = createServerFn({ method: "POST" })
  .validator(githubTokenIdInput)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireRole("admin");
    try {
      await deleteGithubTokenCore(tokenDeps(), data.id);
      return { ok: true };
    } catch (error) {
      asUserError(error);
    }
  });
