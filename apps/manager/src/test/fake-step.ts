import { NonRetryableError } from "cloudflare:workflows";
import type { StepConfig, StepContext, StepRunner } from "../jobs/run-job";

/**
 * Test-only `WorkflowStep` stand-in: runs each step callback inline, retrying
 * (without delay) up to the step's `retries.limit` unless it throws a
 * `NonRetryableError`, and passes `{ attempt }` like the engine does. Records
 * step and sleep names. Results go through a JSON round trip, as the engine
 * persists them, so a non-JSON step result fails the test.
 */
export interface FakeStep extends StepRunner {
  names: string[];
  sleeps: string[];
  configs: Array<StepConfig | undefined>;
  /** Attempts per step name (only steps that ran more than once). */
  retried: Record<string, number>;
}

export function fakeStep(): FakeStep {
  const names: string[] = [];
  const sleeps: string[] = [];
  const configs: Array<StepConfig | undefined> = [];
  const retried: Record<string, number> = {};
  const runner = {
    names,
    sleeps,
    configs,
    retried,
    async do<T>(
      name: string,
      configOrCallback: StepConfig | ((ctx?: StepContext) => Promise<T>),
      maybeCallback?: (ctx?: StepContext) => Promise<T>,
    ): Promise<T> {
      names.push(name);
      const callback = typeof configOrCallback === "function" ? configOrCallback : maybeCallback;
      const config = typeof configOrCallback === "function" ? undefined : configOrCallback;
      configs.push(config);
      if (callback === undefined) throw new Error(`step ${name} has no callback`);
      const limit = config?.retries?.limit ?? 0;
      for (let attempt = 1; ; attempt++) {
        try {
          const result = await callback({ attempt });
          return JSON.parse(JSON.stringify(result ?? null)) as T;
        } catch (error) {
          if (error instanceof NonRetryableError || attempt > limit) throw error;
          retried[name] = attempt + 1;
        }
      }
    },
    async sleep(name: string): Promise<void> {
      sleeps.push(name);
    },
  };
  return runner as FakeStep;
}
