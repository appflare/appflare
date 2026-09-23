import { NonRetryableError } from "cloudflare:workflows";
import type { StepConfig, StepContext, StepRunner } from "../jobs/run-job";

/**
 * Test-only `WorkflowStep` stand-in: runs each step callback inline, retrying
 * (without delay) up to the step's `retries.limit` unless it throws a
 * `NonRetryableError`, and passes `{ attempt }` like the engine does. Records
 * step and sleep names and sleep durations; `onSleep` lets a test advance a
 * fake clock. Results go through a JSON round trip, as the engine persists
 * them, so a non-JSON step result fails the test.
 */
export interface FakeStep extends StepRunner {
  names: string[];
  sleeps: string[];
  /** The duration of each sleep, in order. */
  sleepDurations: Array<string | number>;
  configs: Array<StepConfig | undefined>;
  /** Attempts per step name (only steps that ran more than once). */
  retried: Record<string, number>;
}

export function fakeStep(
  options: { onSleep?: (name: string, duration: string | number) => void } = {},
): FakeStep {
  const names: string[] = [];
  const sleeps: string[] = [];
  const sleepDurations: Array<string | number> = [];
  const configs: Array<StepConfig | undefined> = [];
  const retried: Record<string, number> = {};
  const runner = {
    names,
    sleeps,
    sleepDurations,
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
    async sleep(name: string, duration: string | number): Promise<void> {
      sleeps.push(name);
      sleepDurations.push(duration);
      options.onSleep?.(name, duration);
    },
  };
  return runner as FakeStep;
}
