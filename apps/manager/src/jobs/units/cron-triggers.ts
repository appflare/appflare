import { z } from "zod";
import { type CronTriggerScan, countAccountCronTriggers } from "../install/cron-limit";
import { runUnit, type UnitDeps, type UnitEnv, type UnitResult } from "./result";

/**
 * The job unit `countCronTriggers`: one Worker list and up to `maxWorkers`
 * schedule reads (at most 41 requests), in one invocation of its own when the
 * `SELF` binding exists. Reads only; nothing is cached.
 */

export const cronTriggerCountInputSchema = z.object({
  accountId: z.string().min(1),
  /** The Worker whose schedule the job sets; its current triggers are replaced, so not counted. */
  exclude: z.string().min(1),
  maxWorkers: z.number().int().min(0).max(40),
});
export type CronTriggerCountInput = z.infer<typeof cronTriggerCountInputSchema>;

/** The unit body: {@link countAccountCronTriggers} with the Worker's own token. */
export function runCronTriggerCount(
  env: UnitEnv,
  deps: UnitDeps,
  input: CronTriggerCountInput,
): Promise<UnitResult<CronTriggerScan>> {
  return runUnit(env, deps, input.accountId, async ({ log, cf }) => {
    const scan = await countAccountCronTriggers(cf(), {
      exclude: input.exclude,
      maxWorkers: input.maxWorkers,
    });
    if (scan.kind === "counted") {
      log.info(
        `Read the cron triggers of ${scan.read} Worker(s) with a scheduled handler: ${scan.total} in use.`,
      );
    }
    return scan;
  });
}
