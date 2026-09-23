import { type CloudflareClient, createClient, type FetchLike } from "@appflare/cf-api";
import { apiBaseOption } from "../cloudflare/api-base";
import { createDb, type Database } from "../db/client";
import { errorMessage, JobError, toStepError } from "./errors";
import type { JobContext, StepConfig } from "./run-job";
import { StepLog } from "./step-log";
import { type JobUnitsAccess, jobUnits } from "./units/client";

export { errorMessage, isNotFound, JobError, toStepError } from "./errors";

/**
 * The step runner every job kind shares. Each Cloudflare API call is its own
 * `step.do` with retries for 429/5xx; 4xx and integrity failures end the job at
 * once (`NonRetryableError`). Each step writes its log lines in one batch.
 *
 * Every step of a job runs in the same Worker invocation until a long sleep,
 * so the job's steps share one invocation's subrequest limit. Work that makes
 * many subrequests runs in job units (`steps.units`), each its own invocation
 * when the `SELF` binding exists; what a job still spends in its own
 * invocation is tallied in units/client.ts.
 */

/** 3 retries with backoff on 429/5xx. */
export const API_STEP: StepConfig = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
};

export interface StepTools {
  log: StepLog;
  fetch: FetchLike;
  /** A cf-api client for this step (logs `METHOD path -> status`). */
  cf(): CloudflareClient;
  /** Drizzle over the manager's D1. */
  orm: Database;
  /** 1-based attempt of this step (Workflows retries a failed step). */
  attempt: number;
}

export interface JobSteps {
  /**
   * One `step.do` with logging and error classification; `config` replaces
   * the default {@link API_STEP} retries (a sandbox build needs a long timeout).
   */
  run<T extends object>(
    name: string,
    body: (tools: StepTools) => Promise<T>,
    config?: StepConfig,
  ): Promise<T>;
  /** The step running now, or the phase to blame when a failure happens between steps. */
  current: string;
  /** Cloudflare calls need the account id, which an early step reads from settings. */
  setAccountId(accountId: string): void;
  /** The account id set by {@link JobSteps.setAccountId}. */
  accountId(): string;
  /** The job units: over `SELF` when the Worker has it, else in this invocation. */
  units: JobUnitsAccess;
  /** Fetch for work outside steps. */
  baseFetch: FetchLike;
  now: () => number;
}

export function createJobSteps(ctx: JobContext, jobId: string): JobSteps {
  const { step, env, deps } = ctx;
  const db = env.DB;
  const now = deps.now ?? Date.now;
  const baseFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  let accountId: string | null = null;

  function knownAccount(): string {
    if (accountId === null) throw new JobError("the Cloudflare account is not known yet");
    return accountId;
  }

  function client(log: StepLog): CloudflareClient {
    const token = env.CF_API_TOKEN;
    if (token === undefined || token.length === 0) {
      throw new JobError("the Cloudflare API token is not configured; finish setup first");
    }
    return createClient({
      accountId: knownAccount(),
      token,
      fetch: baseFetch,
      onRequest: log.onRequest,
      ...apiBaseOption(env),
    });
  }

  const steps: JobSteps = {
    current: "start",
    baseFetch,
    now,
    units: jobUnits(env, { ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }), now }),
    setAccountId(id) {
      accountId = id;
    },
    accountId: knownAccount,
    async run(name, body, config = API_STEP) {
      steps.current = name;
      return step.do(name, config, async (stepCtx) => {
        const log = new StepLog(now);
        try {
          const value = await body({
            log,
            fetch: baseFetch,
            cf: () => client(log),
            orm: createDb(db),
            attempt: stepCtx?.attempt ?? 1,
          });
          await log.flush(db, jobId);
          return value;
        } catch (error) {
          log.error(`${name} failed: ${errorMessage(error)}`);
          await log.flush(db, jobId);
          throw toStepError(error);
        }
      });
    },
  };
  return steps;
}
