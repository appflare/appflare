import type { ContainerRollout } from "@appflare/cf-api";
import { z } from "zod";
import { JobError } from "../jobs/errors";
import { runUnit, type UnitDeps, type UnitEnv, type UnitResult } from "../jobs/units/result";
import {
  changeSandboxBinding,
  type SandboxBindingResult,
  SandboxConnectError,
} from "./connect.server";
import { type ContainerProgress, containerProgress } from "./deploy-plan";

/**
 * The job units of enabling, updating and disabling sandbox builds: the
 * parts that make many subrequests, each run in its own invocation over the
 * manager's `SELF` binding (see jobs/units/units.ts).
 *
 * - `waitForSandboxContainers` polls the container applications until they
 *   are ready for builds: Cloudflare prepares a new application's instances (about
 *   a minute), a rollout to a new image takes about a minute and a half.
 * - `setSandboxBinding` adds or removes the manager's own `SANDBOX` binding:
 *   a merge patch of its latest version, up to eight preview probes, and the
 *   deployment (./connect.server.ts).
 */

export const SANDBOX_CONTAINER_WAIT = {
  /** Between two polls of the applications. */
  pollMs: 5_000,
  /**
   * Cloudflare API calls one unit call makes at most (each application is 1,
   * or 2 with a rollout). The sandbox jobs run it only over `SELF`, in its
   * own invocation; they refuse to run without that binding.
   */
  maxCalls: 40,
} as const;

const containerWaitSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  maxInstances: z.number().int().min(1),
  rolloutId: z.string().min(1).nullable(),
});

export const waitForSandboxContainersInputSchema = z.object({
  accountId: z.string().min(1),
  apps: z.array(containerWaitSchema).min(1),
  maxCalls: z.number().int().min(1).max(SANDBOX_CONTAINER_WAIT.maxCalls),
});
export type WaitForSandboxContainersInput = z.infer<typeof waitForSandboxContainersInputSchema>;

export interface WaitForSandboxContainersResult {
  /** Every application is ready. */
  settled: boolean;
  /** Why waiting longer cannot help (a rollout was reverted); null otherwise. */
  failure: string | null;
  /** The last state of each application, for the job log. */
  apps: Array<{ id: string; name: string; settled: boolean; summary: string }>;
}

/** The unit body of `waitForSandboxContainers`. */
export function runWaitForSandboxContainers(
  env: UnitEnv,
  deps: UnitDeps,
  input: WaitForSandboxContainersInput,
): Promise<UnitResult<WaitForSandboxContainersResult>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return runUnit(env, deps, input.accountId, async ({ cf, log }) => {
    const api = cf();
    const state = new Map<string, ContainerProgress>();
    let calls = 0;
    for (;;) {
      for (const app of input.apps) {
        if (state.get(app.id)?.settled === true) continue;
        const cost = app.rolloutId === null ? 1 : 2;
        if (calls + cost > input.maxCalls) break;
        calls += cost;
        const got = await api.containers.getApplication(app.id);
        const rollout: ContainerRollout | null =
          app.rolloutId === null ? null : await api.containers.getRollout(app.id, app.rolloutId);
        const progress = containerProgress(app, got, rollout);
        state.set(app.id, progress);
        if (progress.failure !== null) {
          log.error(progress.summary);
          return { settled: false, failure: progress.failure, apps: report() };
        }
      }
      const pending = input.apps.filter((a) => state.get(a.id)?.settled !== true);
      const cheapest = Math.min(...pending.map((a) => (a.rolloutId === null ? 1 : 2)));
      if (pending.length === 0 || calls + cheapest > input.maxCalls) {
        for (const app of input.apps) {
          const summary = state.get(app.id)?.summary;
          if (summary !== undefined) log.info(summary);
        }
        return { settled: pending.length === 0, failure: null, apps: report() };
      }
      await sleep(SANDBOX_CONTAINER_WAIT.pollMs);
    }

    function report(): WaitForSandboxContainersResult["apps"] {
      return input.apps.map((app) => {
        const progress = state.get(app.id);
        return {
          id: app.id,
          name: app.name,
          settled: progress?.settled === true,
          summary: progress?.summary ?? `${app.name}: not checked yet.`,
        };
      });
    }
  });
}

export const setSandboxBindingInputSchema = z.object({
  accountId: z.string().min(1),
  workerName: z.string().min(1),
  subdomain: z.string().min(1).nullable(),
  currentVersion: z.string().min(1),
  connect: z.boolean(),
});
export type SetSandboxBindingInput = z.infer<typeof setSandboxBindingInputSchema>;

export interface SetSandboxBindingResult extends SandboxBindingResult {
  /** The account's workers.dev subdomain, as used (looked up when the input had none). */
  subdomain: string | null;
}

/** The unit body of `setSandboxBinding`. */
export function runSetSandboxBinding(
  env: UnitEnv,
  deps: UnitDeps,
  input: SetSandboxBindingInput,
): Promise<UnitResult<SetSandboxBindingResult>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return runUnit(env, deps, input.accountId, async ({ cf, fetch, log }) => {
    let subdomain = input.subdomain;
    try {
      const result = await changeSandboxBinding(
        {
          client: cf(),
          workerName: input.workerName,
          subdomain,
          onSubdomain: async (found) => {
            subdomain = found;
          },
          currentVersion: input.currentVersion,
          fetch,
          sleep,
        },
        input.connect,
      );
      const what = input.connect ? "connected to" : "disconnected from";
      log.info(
        result.unchanged
          ? `Appflare's serving version is already ${what} the sandbox Worker; nothing changed.`
          : `Version ${result.versionId} of Appflare's Worker, ${what} the sandbox Worker, passed its check and now serves all traffic.`,
      );
      return { ...result, subdomain };
    } catch (error) {
      // A refusal or a failed preview check: retrying the step would not help.
      if (error instanceof SandboxConnectError) throw new JobError(error.message);
      throw error;
    }
  });
}
