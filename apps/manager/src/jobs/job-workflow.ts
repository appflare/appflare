import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ensureMigrated } from "../db/migrate";
import { type JobParams, runJob, type StepRunner } from "./run-job";
import { selfUnits } from "./units/client";

/**
 * The one Workflow class (binding `JOBS`). Each job is an instance
 * whose payload names its `kind` and `jobId`; `runJob` dispatches.
 */
export class JobWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  override async run(event: Readonly<WorkflowEvent<JobParams>>, step: WorkflowStep): Promise<void> {
    await ensureMigrated(this.env);
    // `step.do`'s overloads constrain callback results to `Rpc.Serializable`; our
    // results are plain JSON. View the stub through `StepRunner` and keep calling
    // `do` as a method on it (it is an RPC stub; `.bind` throws).
    const self = selfUnits(this.env);
    const { SELF: _binding, ...env } = this.env;
    await runJob(
      event.payload,
      step as unknown as StepRunner,
      self === undefined ? env : { ...env, SELF: self },
    );
  }
}
