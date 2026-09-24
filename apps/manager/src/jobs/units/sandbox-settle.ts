import { CloudflareApiError } from "@appflare/cf-api";
import { SANDBOX_WORKER_NAME } from "@appflare/schema";
import { z } from "zod";
import { SandboxProtocolError, sandboxBinding, sandboxInfo } from "../../sandbox/binding";
import { errorMessage, JobError } from "../errors";
import { activeVersionId } from "../update/plan";
import { runUnit, type UnitDeps, type UnitEnv, type UnitResult } from "./result";

/**
 * The job unit `settleSandbox`: waits for the sandbox Worker to settle on
 * one version before a run starts in it.
 *
 * Every secret stored on (or deleted from) the sandbox Worker deploys a new
 * version of it, and a new version resets its Durable Objects, with them any
 * container that is starting: a build or an installer run that begins while
 * the new version rolls out is cut off in its first command. That happens
 * after a job's own secret writes (a self-deploying install stores the app's
 * token and secrets right before its run) and after ones made just before the
 * job started (the admin entering an app's token again on the install page).
 *
 * The unit reads the version Cloudflare lists as deployed, then asks the
 * sandbox Worker which version answers (`info().versionId`, from its version
 * metadata binding) every {@link SANDBOX_SETTLE} `pollMs` until the deployed
 * version has answered `steadyAnswers` times in a row (mode `deployed`). When
 * the deployed version cannot be told (traffic split between versions, or
 * the deployments API answering 429 or 5xx), the same version answering that
 * many times in a row counts (mode `steady`). After `maxAnswers` answers it
 * gives up and reports that it did not settle; the job starts the run anyway,
 * since the sandbox Worker itself starts a run over in a fresh container,
 * once, when a new version resets it as it starts. A sandbox Worker too old
 * to report its version is not waited for (mode `unreported`).
 *
 * Over `SELF` the unit makes 1 deployments read and up to 30 `info()` calls in
 * its own invocation; run in the job's invocation (no `SELF`), the job caps it
 * at 10 answers.
 */

export const SANDBOX_SETTLE = {
  /** Between two `info()` calls. */
  pollMs: 2_000,
  /** Answers in a row from the deployed (or the same) version that count as settled. */
  steadyAnswers: 3,
  /** Answers at most in the unit's own invocation: about a minute of waiting. */
  maxAnswers: 30,
  /** Answers at most when the unit runs in the job's invocation (no `SELF`). */
  maxAnswersInPlace: 10,
} as const;

export const settleSandboxInputSchema = z.object({
  accountId: z.string().min(1),
  maxAnswers: z.number().int().min(1).max(SANDBOX_SETTLE.maxAnswers),
});
export type SettleSandboxInput = z.infer<typeof settleSandboxInputSchema>;

export interface SandboxSettleResult {
  /**
   * `deployed`: waited for the version Cloudflare lists as deployed.
   * `steady`: that version could not be told; waited for one version to answer steadily.
   * `unreported`: the sandbox Worker does not report its version; not waited for.
   */
  mode: "deployed" | "steady" | "unreported";
  /** The deployed version, when it could be told. */
  deployed: string | null;
  /** Why the deployed version could not be told (mode `steady`). */
  steadyReason: string | null;
  /** The version that answered last. */
  answered: string | null;
  answers: number;
  settled: boolean;
  /** The sandbox Worker's Appflare version. */
  sandboxVersion: string;
}

/** Whether a deployments read failed in a way a later read may not (429, 5xx). */
function transientApiError(error: unknown): boolean {
  return error instanceof CloudflareApiError && (error.status === 429 || error.status >= 500);
}

/** The unit body (see the module comment). */
export function runSandboxSettle(
  env: UnitEnv,
  deps: UnitDeps,
  input: SettleSandboxInput,
): Promise<UnitResult<SandboxSettleResult>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  return runUnit(env, deps, input.accountId, async ({ cf }) => {
    const binding = sandboxBinding(env);
    if (binding === undefined) {
      throw new JobError(
        "Appflare is not connected to the sandbox Worker; enable sandbox builds (Settings, Sandbox builds) and try again",
      );
    }
    let deployed: string | null = null;
    let steadyReason: string | null = null;
    try {
      deployed = activeVersionId(await cf().versions.listDeployments(SANDBOX_WORKER_NAME));
      if (deployed === null) steadyReason = "its traffic is split between versions";
    } catch (error) {
      // A permission error, a missing Worker or the subrequest limit is the
      // job's problem, not a reason to wait less carefully.
      if (!transientApiError(error)) throw error;
      steadyReason = `its deployments could not be read (${errorMessage(error)})`;
    }

    let last: string | null = null;
    let steady = 0;
    let sandboxVersion = "";
    for (let answers = 1; answers <= input.maxAnswers; answers++) {
      let info: Awaited<ReturnType<typeof sandboxInfo>>;
      try {
        info = await sandboxInfo(binding);
      } catch (error) {
        if (error instanceof SandboxProtocolError) throw new JobError(error.message);
        throw error;
      }
      sandboxVersion = info.sandboxVersion;
      const answered = info.versionId ?? null;
      const base = { deployed, steadyReason, answers, sandboxVersion };
      if (answered === null) {
        return { ...base, mode: "unreported", answered: null, settled: false };
      }
      if (deployed !== null) steady = answered === deployed ? steady + 1 : 0;
      else steady = answered === last ? steady + 1 : 1;
      last = answered;
      if (steady >= SANDBOX_SETTLE.steadyAnswers) {
        return {
          ...base,
          mode: deployed === null ? "steady" : "deployed",
          answered,
          settled: true,
        };
      }
      if (answers < input.maxAnswers) await sleep(SANDBOX_SETTLE.pollMs);
    }
    return {
      mode: deployed === null ? "steady" : "deployed",
      deployed,
      steadyReason,
      answered: last,
      answers: input.maxAnswers,
      settled: false,
      sandboxVersion,
    };
  });
}
