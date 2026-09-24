import type { StepConfig } from "./run-job";
import type { JobSteps } from "./steps";
import { settleUnit } from "./units/result";
import { SANDBOX_SETTLE, type SandboxSettleResult } from "./units/sandbox-settle";

/**
 * Step "wait for the sandbox Worker to settle", before every build and
 * installer run in the sandbox Worker: a secret change (the job's own, or one
 * made just before it) deploys a new version of the sandbox Worker, which
 * resets a container that is starting. The waiting itself is the job unit
 * `settleSandbox` (units/sandbox-settle.ts).
 *
 * Over `SELF` the unit polls in its own invocation and costs the job one
 * subrequest per attempt; the step retries once (a lost RPC connection).
 * Without `SELF` the unit runs in the job's own invocation, capped at
 * {@link SANDBOX_SETTLE} `maxAnswersInPlace` answers plus one deployments
 * read, and the step does not retry. A wait that ends without settling logs
 * a warning and lets the run start.
 */

export const SANDBOX_SETTLE_STEP = "wait for the sandbox Worker to settle";

/** Over `SELF`: one retry for a lost connection. */
export const SANDBOX_SETTLE_REMOTE_STEP: StepConfig = {
  retries: { limit: 1, delay: "5 seconds", backoff: "constant" },
};

/** In the job's own invocation: every retry would spend its subrequests again. */
export const SANDBOX_SETTLE_IN_PLACE_STEP: StepConfig = {
  retries: { limit: 0, delay: "1 second", backoff: "constant" },
};

function shortId(versionId: string | null): string {
  return versionId === null ? "an unknown version" : versionId.slice(0, 8);
}

/** What the wait found, as the job log says it. */
export function settleMessage(result: SandboxSettleResult, seconds: number): string {
  if (result.mode === "unreported") {
    return `The sandbox Worker ${result.sandboxVersion} does not say which of its versions answers, so Appflare did not wait for a secret change to reach it; update it with \`npx @appflare/cli sandbox enable\`.`;
  }
  const how =
    result.mode === "deployed"
      ? `waited for its deployed version ${shortId(result.deployed)}`
      : `could not tell its deployed version (${result.steadyReason ?? "unknown"}), so waited for one version to answer ${SANDBOX_SETTLE.steadyAnswers} times in a row`;
  if (result.settled) {
    return `The sandbox Worker is settled: Appflare ${how}, and version ${shortId(result.answered)} answered (${result.answers} answer(s)).`;
  }
  return `The sandbox Worker did not settle within ${seconds} seconds: Appflare ${how}, and it last answered from ${shortId(result.answered)}. Starting anyway; if a new version resets the container as the run starts, the sandbox Worker starts it again in a fresh one.`;
}

/** Step "wait for the sandbox Worker to settle" for the account `accountId`. */
export async function awaitSandboxSettledPhase(
  steps: JobSteps,
  accountId: string,
): Promise<SandboxSettleResult> {
  const remote = steps.units.remote;
  const maxAnswers = remote ? SANDBOX_SETTLE.maxAnswers : SANDBOX_SETTLE.maxAnswersInPlace;
  return steps.run(
    SANDBOX_SETTLE_STEP,
    async ({ log }) => {
      const result = settleUnit(
        await steps.units.api.settleSandbox({ accountId, maxAnswers }),
        log,
      );
      const seconds = Math.round(((maxAnswers - 1) * SANDBOX_SETTLE.pollMs) / 1000);
      const message = settleMessage(result, seconds);
      if (result.mode !== "unreported" && !result.settled) log.warn(message);
      else log.info(message);
      return result;
    },
    remote ? SANDBOX_SETTLE_REMOTE_STEP : SANDBOX_SETTLE_IN_PLACE_STEP,
  );
}
