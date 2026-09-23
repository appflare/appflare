import { NonRetryableError } from "cloudflare:workflows";
import {
  CloudflareApiError,
  type CloudflareClient,
  createClient,
  type FetchLike,
} from "@appflare/cf-api";
import { apiBaseOption } from "../cloudflare/api-base";
import { createDb, type Database } from "../db/client";
import { ArtifactError, ArtifactFetchError } from "./install/artifact";
import {
  fetchCost,
  isSubrequestLimitError,
  SubrequestBudget,
  subrequestLimitMessage,
} from "./install/budget";
import { countD1 } from "./install/count-d1";
import type { JobContext, StepConfig } from "./run-job";
import { StepLog } from "./step-log";

/**
 * The step runner every job kind shares. Each Cloudflare API call is its own
 * `step.do` with retries for 429/5xx; 4xx and integrity failures end the job at
 * once (`NonRetryableError`). Each step writes its log lines in one batch and
 * reports the subrequests it made, so the job can sleep at a budget boundary
 * before the free plan's per-invocation limit.
 */

/** 3 retries with backoff on 429/5xx. */
export const API_STEP: StepConfig = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
};

/** A failure the job reports as is; never retried. */
export class JobError extends Error {
  override name = "JobError";
}

/**
 * D1 calls a step makes on top of its estimate (the log flush plus a write or
 * two); D1 calls are subrequests too. The headroom between the budget (40) and
 * the cap (50) covers per-invocation work outside steps (`ensureMigrated`,
 * re-reading the manifest from KV).
 */
const D1_PER_STEP = 3;

/** Maps any error thrown inside a step to what the Workflow engine should do with it. */
export function toStepError(error: unknown): Error {
  if (error instanceof NonRetryableError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // Retries run in the same invocation, so they could only hit the limit again.
  if (isSubrequestLimitError(error)) return new NonRetryableError(subrequestLimitMessage(message));
  if (error instanceof CloudflareApiError) {
    return error.status === 429 || error.status >= 500
      ? new Error(message)
      : new NonRetryableError(message);
  }
  if (error instanceof ArtifactFetchError) {
    return error.retryable ? new Error(message) : new NonRetryableError(message);
  }
  if (error instanceof JobError || error instanceof ArtifactError) {
    return new NonRetryableError(message);
  }
  return error instanceof Error ? error : new Error(message);
}

/** The message without the engine's `Error:` prefixes. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^(NonRetryableError|Error):\s*/, "");
}

/** Whether a Cloudflare call failed because the object does not exist (anymore). */
export function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

export interface StepTools {
  log: StepLog;
  /** Fetch that counts subrequests (redirect hops included). */
  fetch: FetchLike;
  /** A cf-api client for this step (logs `METHOD path -> status`). */
  cf(): CloudflareClient;
  /** Drizzle over the manager's D1, counted against the step's subrequests. */
  orm: Database;
  /** 1-based attempt of this step (Workflows retries a failed step). */
  attempt: number;
}

export interface JobSteps {
  /**
   * One `step.do` with logging, subrequest counting, and error classification.
   * `estimate` is the subrequests the step may make besides its D1 writes; a
   * `step.sleep` boundary comes first when it would pass the budget.
   */
  run<T extends object>(
    name: string,
    estimate: number,
    body: (tools: StepTools) => Promise<T>,
  ): Promise<T & { subrequests: number }>;
  /** The step running now, or the phase to blame when a failure happens between steps. */
  current: string;
  /** Cloudflare calls need the account id, which an early step reads from settings. */
  setAccountId(accountId: string): void;
  /** Any other `step.sleep` (health-check waits) also starts a fresh invocation. */
  resetBudget(): void;
  /** Fetch without step accounting, for work outside steps. */
  baseFetch: FetchLike;
  now: () => number;
}

export function createJobSteps(ctx: JobContext, jobId: string): JobSteps {
  const { step, env, deps } = ctx;
  const db = env.DB;
  const now = deps.now ?? Date.now;
  const baseFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const budget = new SubrequestBudget();
  let accountId: string | null = null;

  function client(fetchImpl: FetchLike, log: StepLog): CloudflareClient {
    const token = env.CF_API_TOKEN;
    if (token === undefined || token.length === 0) {
      throw new JobError("the Cloudflare API token is not configured; finish setup first");
    }
    if (accountId === null) throw new JobError("the Cloudflare account is not known yet");
    return createClient({
      accountId,
      token,
      fetch: fetchImpl,
      onRequest: log.onRequest,
      ...apiBaseOption(env),
    });
  }

  const steps: JobSteps = {
    current: "start",
    baseFetch,
    now,
    setAccountId(id) {
      accountId = id;
    },
    resetBudget() {
      budget.reset();
    },
    async run(name, estimate, body) {
      if (budget.needsBoundary(estimate + D1_PER_STEP)) {
        await step.sleep(`budget ${budget.boundary()}`, "1 second");
      }
      steps.current = name;
      const result = await step.do(name, API_STEP, async (stepCtx) => {
        const log = new StepLog(now);
        let subrequests = 0;
        const countedDb = countD1(db, () => {
          subrequests += 1;
        });
        const counted: FetchLike = async (input, init) => {
          try {
            const response = await baseFetch(input, init);
            subrequests += fetchCost(response);
            return response;
          } catch (error) {
            subrequests += 1;
            throw error;
          }
        };
        try {
          const value = await body({
            log,
            fetch: counted,
            cf: () => client(counted, log),
            orm: createDb(countedDb),
            attempt: stepCtx?.attempt ?? 1,
          });
          await log.flush(countedDb, jobId);
          return { ...value, subrequests };
        } catch (error) {
          log.error(`${name} failed: ${errorMessage(error)}`);
          await log.flush(countedDb, jobId);
          throw toStepError(error);
        }
      });
      budget.add(result.subrequests);
      return result;
    },
  };
  return steps;
}
