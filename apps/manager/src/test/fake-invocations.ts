import { NonRetryableError } from "cloudflare:workflows";
import type { FetchLike } from "@appflare/cf-api";
import { FREE_PLAN_SUBREQUESTS } from "@appflare/schema";
import type { StepConfig, StepContext, StepRunner } from "../jobs/run-job";

/**
 * Test-only Workflow engine that keeps Workers Free's subrequest limit per
 * invocation, as measured on a real account (../jobs/invocation-budget.ts):
 *
 * - every request the job makes in its own invocation counts (a fetch, two
 *   for a followed redirect; a call to a job unit, one); the 51st throws the
 *   runtime's "Too many subrequests" error;
 * - steps run back to back in one invocation; retries and sleeps shorter
 *   than 5 minutes stay in it;
 * - a sleep of 5 minutes or more ends the invocation: the job runs again
 *   from the top in a new one, where every step and sleep it already did
 *   returns its recorded result (or throws its recorded error) without
 *   running, and the count starts at zero.
 *
 * Step and sleep results are keyed by name and by how many times the run
 * reached that name before, as the engine keys them. Results go through a
 * JSON round trip, as the engine persists them.
 */
export interface FakeEngine {
  step: StepRunner;
  /** Steps whose bodies ran, in order, with the invocation each ran in (0-based). */
  ran: Array<{ name: string; invocation: number }>;
  /** Sleeps the job reached for the first time, in order. */
  sleeps: Array<{ name: string; duration: string | number }>;
  /** The requests each invocation made, in order. */
  invocations: number[];
  /** `inner`, counted against the current invocation. */
  fetch(inner: FetchLike): FetchLike;
  /** `api`'s methods, each call counted as one request of the current invocation. */
  units<T extends object>(api: T): T;
  /** Runs the job until it finishes, again from the top after every long sleep. */
  run(job: () => Promise<void>): Promise<void>;
}

/** The runtime's message for the request past the limit. */
export const TOO_MANY_SUBREQUESTS =
  "Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits";

/** A sleep of this long or longer resumes the job in a new invocation. */
const FRESH_INVOCATION_MS = 5 * 60_000;

function durationMs(duration: string | number): number {
  if (typeof duration === "number") return duration;
  const match = /^(\d+(?:\.\d+)?)\s*(millisecond|second|minute|hour|day)s?$/.exec(duration.trim());
  if (match === null) throw new Error(`unknown duration ${duration}`);
  const unit = { millisecond: 1, second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  return Number(match[1]) * unit[match[2] as keyof typeof unit];
}

type Recorded = { ok: true; value: unknown } | { ok: false; error: unknown };

export function fakeEngine(
  options: { onSleep?: (name: string, duration: string | number) => void; maxRuns?: number } = {},
): FakeEngine {
  const recorded = new Map<string, Recorded>();
  const slept = new Set<string>();
  const ran: FakeEngine["ran"] = [];
  const sleeps: FakeEngine["sleeps"] = [];
  const invocations: number[] = [];
  /** How many times this run reached each name. */
  let reached = new Map<string, number>();
  let hibernate: (() => void) | null = null;

  function key(name: string): string {
    const n = (reached.get(name) ?? 0) + 1;
    reached.set(name, n);
    return `${name}#${n}`;
  }

  function spend(count: number): void {
    const at = invocations.length - 1;
    if (at < 0) throw new Error("a request outside a run of the job");
    const now = (invocations[at] ?? 0) + count;
    invocations[at] = now;
    if (now > FREE_PLAN_SUBREQUESTS) throw new Error(TOO_MANY_SUBREQUESTS);
  }

  const step: StepRunner = {
    async do<T>(
      name: string,
      configOrCallback: StepConfig | ((ctx?: StepContext) => Promise<T>),
      maybeCallback?: (ctx?: StepContext) => Promise<T>,
    ): Promise<T> {
      const k = key(name);
      const seen = recorded.get(k);
      if (seen !== undefined) {
        if (seen.ok) return seen.value as T;
        throw seen.error;
      }
      const callback = typeof configOrCallback === "function" ? configOrCallback : maybeCallback;
      const config = typeof configOrCallback === "function" ? undefined : configOrCallback;
      if (callback === undefined) throw new Error(`step ${name} has no callback`);
      ran.push({ name, invocation: invocations.length - 1 });
      const limit = config?.retries?.limit ?? 0;
      for (let attempt = 1; ; attempt++) {
        try {
          const value = JSON.parse(JSON.stringify((await callback({ attempt })) ?? null)) as T;
          recorded.set(k, { ok: true, value });
          return value;
        } catch (error) {
          if (error instanceof NonRetryableError || attempt > limit) {
            recorded.set(k, { ok: false, error });
            throw error;
          }
        }
      }
    },
    async sleep(name: string, duration: string | number): Promise<void> {
      const k = key(name);
      if (slept.has(k)) return;
      slept.add(k);
      sleeps.push({ name, duration });
      options.onSleep?.(name, duration);
      if (durationMs(duration) < FRESH_INVOCATION_MS) return;
      // The invocation ends here; this run of the job never resumes.
      hibernate?.();
      await new Promise<never>(() => {});
    },
  };

  return {
    step,
    ran,
    sleeps,
    invocations,
    fetch(inner) {
      return async (input, init) => {
        spend(1);
        const response = await inner(input, init);
        if (response.redirected) spend(1);
        return response;
      };
    },
    units<T extends object>(api: T): T {
      const methods = api as Record<string, unknown>;
      const counted: Record<string, unknown> = { ...methods };
      for (const [name, value] of Object.entries(methods)) {
        if (typeof value !== "function") continue;
        counted[name] = (...args: unknown[]) => {
          spend(1);
          return (value as (...a: unknown[]) => unknown).apply(api, args);
        };
      }
      return counted as T;
    },
    async run(job) {
      for (let runs = 0; runs < (options.maxRuns ?? 100); runs++) {
        reached = new Map();
        invocations.push(0);
        const ended = new Promise<"hibernated">((resolve) => {
          hibernate = () => resolve("hibernated");
        });
        const outcome = await Promise.race([job().then(() => "done" as const), ended]);
        if (outcome === "done") return;
      }
      throw new Error("the job never finished");
    },
  };
}
