import { NonRetryableError } from "cloudflare:workflows";
import type { FetchLike } from "@appflare/cf-api";
import type { SigningKey } from "@appflare/schema";
import { z } from "zod";
import { JOB_KINDS, type JobKind } from "../db/schema";
import { runInstall } from "./install";
import { runRollback } from "./rollback";
import { runSelfUpdate } from "./self-update";
import { runUninstall } from "./uninstall";
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
}

/** Test seams. Production uses the global `fetch`, `signingKeys`, and `Date.now`. */
export interface JobDeps {
  fetch?: FetchLike;
  signingKeys?: readonly SigningKey[];
  now?: () => number;
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
  await handlers[parsed.data.kind]({ params: parsed.data, step, env, deps });
}
