import { NonRetryableError } from "cloudflare:workflows";
import type { FetchLike } from "@appflare/cf-api";
import type { SigningKey } from "@appflare/schema";
import { z } from "zod";
import { JOB_KINDS, type JobKind } from "../db/schema";
import { notifyJobEnd } from "../notifications/job-end";
import { runSandboxDisable } from "../sandbox/disable-job";
import { runSandboxEnable } from "../sandbox/enable-job";
import { runInstall } from "./install";
import { runReconfigure } from "./reconfigure";
import { runRollback } from "./rollback";
import { runSelfUpdate } from "./self-update";
import { runUninstall } from "./uninstall";
import type { JobUnitsApi } from "./units/units";
import { runUpdate } from "./update";

/**
 * Job dispatch for `JobWorkflow` (one Workflow class, dispatching on
 * `kind`). Kept free of the Workflow class so it can be tested with a fake step.
 */

/** `step.do` options (Workflows `WorkflowStepConfig`). */
export interface StepConfig {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
}

/**
 * The subset of `WorkflowStep` jobs use. `WorkflowStep` is an RPC stub: call
 * `step.do(...)` as a method on it, never `step.do.bind(step)`.
 * Step results must be plain JSON.
 */
/** What the engine passes a step callback (`WorkflowStepContext`, the part jobs read). */
export interface StepContext {
  /** 1-based attempt number of this step. */
  attempt: number;
}

export interface StepRunner {
  do<T>(name: string, callback: (ctx?: StepContext) => Promise<T>): Promise<T>;
  do<T>(name: string, config: StepConfig, callback: (ctx?: StepContext) => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
}

/**
 * Every job payload carries `kind` and `jobId`; each kind's handler parses the
 * rest of its own payload (the install payload is `installJobParams`).
 */
export const jobParams = z.looseObject({
  kind: z.enum(JOB_KINDS),
  jobId: z.string().min(1),
});
export type JobParams = z.infer<typeof jobParams>;

/** Bindings and vars a job reads. */
export interface JobEnv {
  DB: D1Database;
  /**
   * The catalog cache: jobs read verified manifests from it by digest, and the
   * update job reads the cached index entry of the app.
   */
  KV?: KVNamespace;
  CF_API_TOKEN?: string;
  /** Optional Cloudflare API base override (tests, local dev against a fake API). */
  CF_API_BASE_URL?: string;
  /** The running manager's version; the self-update compares it with its target. */
  APPFLARE_VERSION?: string;
  /** Reads the manager's release assets while its repository is private. Never logged. */
  GITHUB_TOKEN?: string;
  /** The releases API override (local dev, tests); the sandbox Worker release is read next to it. */
  MANAGER_RELEASES_URL?: string;
  /**
   * The manager's own job units over its `SELF` service binding. Absent on a
   * manager deployed before the binding existed; jobs then run the units in
   * their own invocation.
   */
  SELF?: JobUnitsApi;
  /**
   * The sandbox Worker (`appflare-sandbox`) over the `SANDBOX` service
   * binding, on managers connected to sandbox builds. Read it through
   * `sandboxBinding()`.
   */
  SANDBOX?: unknown;
}

/** Test seams. Production uses the global `fetch`, `signingKeys`, `Date.now`, and timers. */
export interface JobDeps {
  fetch?: FetchLike;
  signingKeys?: readonly SigningKey[];
  now?: () => number;
  /** A short wait inside a step, in milliseconds. */
  sleep?: (ms: number) => Promise<void>;
}

export interface JobContext {
  params: JobParams;
  step: StepRunner;
  env: JobEnv;
  deps: JobDeps;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export const JOB_HANDLERS: Record<JobKind, JobHandler> = {
  install: runInstall,
  update: runUpdate,
  rollback: runRollback,
  self_update: runSelfUpdate,
  uninstall: runUninstall,
  reconfigure: runReconfigure,
  sandbox_enable: runSandboxEnable,
  sandbox_update: runSandboxEnable,
  sandbox_disable: runSandboxDisable,
};

export async function runJob(
  payload: unknown,
  step: StepRunner,
  env: JobEnv,
  handlers: Record<JobKind, JobHandler> = JOB_HANDLERS,
  deps: JobDeps = {},
): Promise<void> {
  const parsed = jobParams.safeParse(payload);
  if (!parsed.success) throw new NonRetryableError("invalid job payload");
  const ctx: JobContext = { params: parsed.data, step, env, deps };
  try {
    await handlers[parsed.data.kind](ctx);
  } finally {
    // Tells notification channels the job ended; never throws, and skips
    // self-updates, after whose promotion nothing else may run.
    await notifyJobEnd(ctx);
  }
}
