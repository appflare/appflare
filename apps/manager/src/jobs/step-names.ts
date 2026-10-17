import type { StepConfig, StepContext, StepRunner } from "./run-job";

/**
 * The Workflows engine refuses a step or sleep whose name is longer than
 * 256 characters ("Step name … exceeds max length (256 chars)", workers-sdk
 * `packages/workflows-shared/src/lib/validators.ts`, `MAX_STEP_NAME_LENGTH`),
 * which ends the job. Step names carry Worker, queue and Workflow names,
 * and a step about several Workers lists them all, so a long one is cut
 * here, with a hash of the whole name after the cut: the same name always
 * gives the same step (a replay finds it), and two long names that start
 * alike stay two steps.
 */
export const MAX_STEP_NAME_LENGTH = 256;

/** FNV-1a over the name's UTF-16 code units, as 8 hex digits. */
function nameHash(name: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** `name`, or for one longer than the engine takes, its start and a hash of all of it. */
export function boundedStepName(name: string): string {
  if (name.length <= MAX_STEP_NAME_LENGTH) return name;
  const suffix = ` … ${nameHash(name)}`;
  let cut = MAX_STEP_NAME_LENGTH - suffix.length;
  // Never between the two halves of a surrogate pair (an emoji in a name).
  if (isHighSurrogate(name.charCodeAt(cut - 1))) cut -= 1;
  return `${name.slice(0, cut).trimEnd()}${suffix}`;
}

type StepCallback<T> = (ctx?: StepContext) => Promise<T>;

/**
 * `step` with every step and sleep name bounded ({@link boundedStepName}).
 * Calls `do` and `sleep` as methods of `step` (never through `.call` or
 * `.bind`, which an RPC stub would read as remote properties).
 */
export function withBoundedStepNames(step: StepRunner): StepRunner {
  function run<T>(
    name: string,
    configOrCallback: StepConfig | StepCallback<T>,
    callback?: StepCallback<T>,
  ): Promise<T> {
    const bounded = boundedStepName(name);
    if (typeof configOrCallback === "function") return step.do(bounded, configOrCallback);
    if (callback === undefined) throw new TypeError(`step ${bounded} has no callback`);
    return step.do(bounded, configOrCallback, callback);
  }
  return {
    do: run,
    sleep: (name, duration) => step.sleep(boundedStepName(name), duration),
  };
}
