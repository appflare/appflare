import { NonRetryableError } from "cloudflare:workflows";
import {
  CloudflareApiError,
  type CloudflareClient,
  type CloudflareError,
  createClient,
  type FetchLike,
} from "@appflare/cf-api";
import { apiBaseOption } from "../../cloudflare/api-base";
import { errorMessage, JobError, toStepError } from "../errors";
import { fetchCost } from "../install/budget";
import { type LogLine, StepLog } from "../step-log";

/**
 * How a job unit reports back. A unit may run in another invocation of the
 * manager (an RPC call through the `SELF` service binding), where errors lose
 * their class on the way back, so every unit returns a plain result instead of
 * throwing: its value or a failure, the log lines it wrote, and how many
 * subrequests it made. The job's step turns a failure back into the error the
 * step runner classifies ({@link settleUnit}), so retries behave the same
 * whether the unit ran over RPC or in the job's own invocation.
 */

/** The log lines and `METHOD path -> status` records of one unit call. */
export interface UnitLog {
  lines: LogLine[];
  requests: string[];
}

/** Why a unit failed, in a shape that survives an RPC call. */
export type UnitFailure = UnitFailureCause & {
  /** What the unit was working on when it failed (a migration file), named in the message. */
  subject?: string;
};

type UnitFailureCause =
  /** A Cloudflare API error, rebuilt as a `CloudflareApiError` so 429/5xx retry and 4xx do not. */
  | {
      kind: "cloudflare";
      status: number;
      method: string;
      path: string;
      errors: CloudflareError[];
    }
  /** A failure no retry can fix (integrity, refusals, the subrequest limit). */
  | { kind: "final"; message: string }
  /** A failure a retry may fix (a network error, a 5xx from the artifact host). */
  | { kind: "retry"; message: string };

export type UnitResult<T> =
  | { ok: true; value: T; log: UnitLog; subrequests: number }
  | { ok: false; failure: UnitFailure; log: UnitLog; subrequests: number };

/** Secrets and settings a unit reads from the Worker it runs in, never from its input. */
export interface UnitEnv {
  CF_API_TOKEN?: string;
  CF_API_BASE_URL?: string;
  GITHUB_TOKEN?: string;
  /** The sandbox Worker, whose `fetch` serves sandbox builds (artifact host kind `sandbox`). */
  SANDBOX?: unknown;
}

/** Test seams; production uses the global `fetch`, `Date.now`, and timers. */
export interface UnitDeps {
  fetch?: FetchLike;
  now?: () => number;
  /** A wait inside a unit, in milliseconds (`settleSandbox` polls with it). */
  sleep?: (ms: number) => Promise<void>;
}

export interface UnitTools {
  log: StepLog;
  /** Fetch that counts the unit's subrequests (redirect hops included). */
  fetch: FetchLike;
  /** A cf-api client with the Worker's own API token. */
  cf(): CloudflareClient;
}

/**
 * An error a unit raises about one item of its work, such as the migration
 * file whose statement failed: the failure keeps the original error's class
 * and message and names the item in front of it.
 */
export class UnitItemError extends Error {
  override name = "UnitItemError";
  constructor(
    readonly subject: string,
    override readonly cause: unknown,
  ) {
    super(`${subject}: ${errorMessage(cause)}`);
  }
}

/** The failure a thrown error becomes, classified the way the step runner would. */
export function describeFailure(error: unknown): UnitFailure {
  if (error instanceof UnitItemError) {
    return { ...describeFailure(error.cause), subject: error.subject };
  }
  if (error instanceof CloudflareApiError) {
    return {
      kind: "cloudflare",
      status: error.status,
      method: error.method,
      path: error.path,
      errors: error.errors,
    };
  }
  const mapped = toStepError(error);
  return {
    kind: mapped instanceof NonRetryableError ? "final" : "retry",
    message: errorMessage(mapped),
  };
}

/** The error a step throws for a unit failure; `toStepError` then treats it as the original. */
export function failureError(failure: UnitFailure): Error {
  const about = (message: string) =>
    failure.subject === undefined ? message : `${failure.subject}: ${message}`;
  switch (failure.kind) {
    case "cloudflare": {
      const error = new CloudflareApiError(failure);
      error.message = about(error.message);
      return error;
    }
    case "final":
      return new NonRetryableError(about(failure.message));
    case "retry":
      return new Error(about(failure.message));
  }
}

/**
 * Runs one unit body with a counting fetch and a log, and returns its result
 * instead of throwing.
 */
export async function runUnit<T>(
  env: UnitEnv,
  deps: UnitDeps,
  accountId: string,
  body: (tools: UnitTools) => Promise<T>,
): Promise<UnitResult<T>> {
  const log = new StepLog(deps.now ?? Date.now);
  const base: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  let subrequests = 0;
  const counted: FetchLike = async (input, init) => {
    try {
      const response = await base(input, init);
      subrequests += fetchCost(response);
      return response;
    } catch (error) {
      subrequests += 1;
      throw error;
    }
  };
  const cf = (): CloudflareClient => {
    const token = env.CF_API_TOKEN;
    if (token === undefined || token.length === 0) {
      throw new JobError("the Cloudflare API token is not configured; finish setup first");
    }
    return createClient({
      accountId,
      token,
      fetch: counted,
      onRequest: log.onRequest,
      ...apiBaseOption(env),
    });
  };
  const unitLog = (): UnitLog => ({ lines: [...log.lines], requests: [...log.requests] });
  try {
    const value = await body({ log, fetch: counted, cf });
    return { ok: true, value, log: unitLog(), subrequests };
  } catch (error) {
    return { ok: false, failure: describeFailure(error), log: unitLog(), subrequests };
  }
}

/**
 * Inside a step: copies the unit's log into the step's log (written with the
 * step's own lines, in one batch) and returns its value, or throws the error
 * its failure stands for.
 */
export function settleUnit<T>(result: UnitResult<T>, log: StepLog): T {
  const lines = result.log.lines.map((line) => ({ ...line }));
  const last = lines.at(-1);
  if (last !== undefined) last.data = { ...last.data, subrequests: result.subrequests };
  log.lines.push(...lines);
  log.requests.push(...result.log.requests);
  log.apiCalls += result.log.requests.length;
  if (result.ok) return result.value;
  throw failureError(result.failure);
}
