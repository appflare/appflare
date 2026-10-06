import { NonRetryableError } from "cloudflare:workflows";
import { type CloudflareClient, createClient, type FetchLike } from "@appflare/cf-api";
import { probeCredentials, zoneNamesVia } from "../access/probe-credentials.server";
import { apiBaseOption } from "../cloudflare/api-base";
import { type CloudflareConnection, cloudflareConnection } from "../cloudflare/connection.server";
import { inConnectionWordsOf } from "../cloudflare/sign-in-words.server";
import { createDb, type Database } from "../db/client";
import { errorMessage, JobError, toStepError } from "./errors";
import { isSubrequestLimitError } from "./install/budget";
import type { InstallProbeHeaders } from "./install/health";
import { countedUnits, FRESH_INVOCATION_SLEEP, InvocationBudget } from "./invocation-budget";
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
 * invocation is tallied in units/client.ts. A job that may need more than one
 * invocation (an app of several Workers on Workers Free) calls
 * {@link JobSteps.spreadOverInvocations}: from then on each step that might
 * not fit what is left of the invocation's 50 starts after a sleep that
 * resumes the job in a fresh one (./invocation-budget.ts).
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
  /**
   * A cf-api client that calls with another API token, one an admin created
   * for an app (a Pipelines sink's catalog token), logged the same way.
   */
  cfAs(token: string): CloudflareClient;
  /** Drizzle over the manager's D1. */
  orm: Database;
  /** 1-based attempt of this step (Workflows retries a failed step). */
  attempt: number;
  /**
   * A protected install's own service token headers for a health check of
   * one of its addresses (access/probe-credentials.server.ts). Use them in
   * the request only; never return them from the step, or they would be
   * stored with it.
   */
  probeHeaders: InstallProbeHeaders;
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
  /** A short wait inside a step (seconds; a longer wait is a `step.sleep`). */
  sleep: (ms: number) => Promise<void>;
  /**
   * From now on, a step that might not fit what is left of this invocation's
   * subrequests on Workers Free waits for a fresh invocation first, and a
   * step that still runs out of them runs once more in a fresh one.
   */
  spreadOverInvocations(): void;
  /** What this invocation has spent (fetches and unit calls), and whether the job spreads. */
  readonly invocation: Pick<InvocationBudget, "spent" | "spreading">;
  /**
   * Runs `block` (steps that should run back to back, such as switching every
   * Worker of an app to a version, or a health check whose window counts
   * seconds) in one invocation: when the job spreads and fewer than `need`
   * requests are left in this one, it waits for a fresh invocation first, and
   * no step of the block waits between them. `name` names that wait.
   */
  reserve<T>(name: string, need: number, block: () => Promise<T>): Promise<T>;
}

/**
 * Added to the failure of a step that used up the job's own invocation (not
 * a unit's), which a job that spreads runs once more in a fresh one.
 */
export const OWN_LIMIT_NOTE = "The job's own requests used up what this run of it may make.";

/** The job log's line when a job waits for a fresh invocation. */
export const FRESH_INVOCATION_NOTE =
  "Waiting 5 minutes before the next step: on Workers Free, Cloudflare lets a job make 50 requests at a time, and this app's Workers need more. The job carries on by itself with a fresh allowance.";

export function createJobSteps(ctx: JobContext, jobId: string): JobSteps {
  const { step, env, deps } = ctx;
  const db = env.DB;
  const now = deps.now ?? Date.now;
  // Counted per run of the job: a job resumed after a long sleep runs again
  // from the top, in a fresh invocation, and replays its steps for free.
  const budget = ctx.budget ?? new InvocationBudget();
  const baseFetch: FetchLike = budget.countingFetch(
    deps.fetch ?? ((input, init) => fetch(input, init)),
  );
  const units = jobUnits(env, {
    // Units run in place (no `SELF`) spend this invocation's requests.
    fetch: baseFetch,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    now,
  });
  let accountId: string | null = null;
  /**
   * The manager's own Cloudflare credential, one provider for the whole run:
   * it reads D1 once and then answers from this isolate's memo, renewing an
   * OAuth access token when it runs out, through the counting fetch.
   */
  let connection: CloudflareConnection | null = null;
  /** How many times each step name was run so far, replays included, for unique pause names. */
  const seen = new Map<string, number>();

  function knownAccount(): string {
    if (accountId === null) throw new JobError("the Cloudflare account is not known yet");
    return accountId;
  }

  function client(log: StepLog, other?: string): CloudflareClient {
    connection ??= cloudflareConnection(env, {
      fetch: baseFetch,
      now,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    });
    return createClient({
      accountId: knownAccount(),
      token: other ?? connection.token,
      // Another token (an app's own) is sent as is; the manager's own access
      // token is renewed once when the API refuses it.
      fetch: other === undefined ? connection.retrying(baseFetch) : baseFetch,
      onRequest: log.onRequest,
      ...apiBaseOption(env),
    });
  }

  /**
   * Sleeps until the job resumes in a fresh invocation, with a line in the
   * job log. Named after the step it comes before, so a replay finds it.
   */
  async function freshInvocation(before: string): Promise<void> {
    await step.do(`wait for a fresh invocation before ${before}`, async () => {
      const log = new StepLog(now);
      log.info(FRESH_INVOCATION_NOTE, { spent: budget.spent });
      await log.flush(db, jobId);
      return {};
    });
    await step.sleep(`fresh invocation before ${before}`, FRESH_INVOCATION_SLEEP);
    // A sleep of 5 minutes ends the invocation (measured, see
    // ./invocation-budget.ts): the engine resumes the job in a new one, which
    // runs from the top with a new count and passes this sleep as done, so
    // this line runs only if the engine kept the invocation through it. Then
    // the count is taken as fresh anyway; if the old allowance were really
    // still in force, the next step would run out, fail with the subrequest
    // limit, run once more after another such sleep, and fail the job if
    // that one runs out too. It never loops.
    budget.fresh();
  }

  /** A name for a wait that is unique among the job's waits, replays included. */
  function uniqueName(name: string): string {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} (${count})`;
  }

  const steps: JobSteps = {
    current: "start",
    baseFetch,
    now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    units: units.remote
      ? { api: countedUnits(units.api, () => budget.add(1)), remote: true }
      : units,
    invocation: budget,
    spreadOverInvocations() {
      budget.spread();
    },
    async reserve(name, need, block) {
      const unique = uniqueName(`reserve:${name}`).slice("reserve:".length);
      if (budget.needsFreshFor(need)) await freshInvocation(unique);
      if (!budget.canHold(need)) return block();
      budget.hold(true);
      try {
        return await block();
      } finally {
        budget.hold(false);
      }
    },
    setAccountId(id) {
      accountId = id;
    },
    accountId: knownAccount,
    async run(name, body, config = API_STEP) {
      const unique = uniqueName(name);
      if (budget.needsFresh()) await freshInvocation(unique);
      steps.current = name;
      try {
        return await runStep(name, body, config);
      } catch (error) {
        // Planned steps fit, but one that still ran out of this invocation's
        // subrequests runs once more in a fresh one. Every step is safe to
        // run again: the engine retries any of them after a 5xx. Decided
        // from the recorded failure, so a replay decides the same; a unit
        // that ran out of its own allowance fails the job as before.
        if (!budget.spreading || !errorMessage(error).includes(OWN_LIMIT_NOTE)) throw error;
        await freshInvocation(`${unique} again`);
        steps.current = name;
        return await runStep(`${name} (again)`, body, config);
      }
    },
  };

  /**
   * A refusal written for an API token says, on a manager connected with
   * Cloudflare sign-in, what the sign-in needs instead. Reads the connection
   * only for such a message.
   */
  async function inSignInWords(error: unknown): Promise<void> {
    if (error instanceof Error) error.message = await inConnectionWordsOf(db, error.message);
  }

  /** The same for the step's log lines (a warning that a permission is missing), before they are written. */
  async function inSignInLines(log: StepLog): Promise<void> {
    for (const line of log.lines) line.message = await inConnectionWordsOf(db, line.message);
  }

  async function runStep<T extends object>(
    name: string,
    body: (tools: StepTools) => Promise<T>,
    config: StepConfig,
  ): Promise<T> {
    return step.do(name, config, async (stepCtx) => {
      const log = new StepLog(now);
      try {
        const value = await body({
          log,
          fetch: baseFetch,
          cf: () => client(log),
          cfAs: (token) => {
            if (token.length === 0) throw new JobError("no API token was given for this call");
            return client(log, token);
          },
          orm: createDb(db),
          attempt: stepCtx?.attempt ?? 1,
          probeHeaders: (installId, url) =>
            probeCredentials(
              {
                db,
                authSecret: env.BETTER_AUTH_SECRET,
                zoneNames: zoneNamesVia(async () => client(log)),
              },
              installId,
              url,
            ),
        });
        await inSignInLines(log);
        await log.flush(db, jobId);
        return value;
      } catch (error) {
        await inSignInWords(error);
        const failure = toStepError(error);
        // The job's own invocation ran out (not a unit's): said so, for the rerun above.
        const own =
          isSubrequestLimitError(error) && budget.exhausted()
            ? new NonRetryableError(`${errorMessage(failure)} ${OWN_LIMIT_NOTE}`)
            : failure;
        log.error(`${name} failed: ${errorMessage(own)}`);
        await inSignInLines(log);
        await log.flush(db, jobId);
        throw own;
      }
    });
  }
  return steps;
}
