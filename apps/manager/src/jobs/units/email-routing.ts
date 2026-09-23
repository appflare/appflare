import { catalogEmailRoutingSchema } from "@appflare/schema";
import { z } from "zod";
import {
  type EmailRoutingInspection,
  inspectEmailRouting,
} from "../../installs/email-routing.server";
import { runUnit, type UnitDeps, type UnitEnv, type UnitResult } from "./result";

/**
 * The job unit `inspectEmailRouting`: everything the install job reads about
 * a zone before an email app is installed there (3 to about 8 requests), in
 * one invocation of its own when the `SELF` binding exists.
 */

/** A zone id as the install job carries it. */
export const zoneIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const emailRoutingInspectInputSchema = z.object({
  accountId: z.string().min(1),
  zoneId: zoneIdSchema,
  config: catalogEmailRoutingSchema,
  workerName: z.string().min(1),
});
export type EmailRoutingInspectInput = z.infer<typeof emailRoutingInspectInputSchema>;

/** The unit body: {@link inspectEmailRouting} with the Worker's own token. */
export function runEmailRoutingInspection(
  env: UnitEnv,
  deps: UnitDeps,
  input: EmailRoutingInspectInput,
): Promise<UnitResult<EmailRoutingInspection>> {
  return runUnit(env, deps, input.accountId, async ({ log, cf }) => {
    const inspection = await inspectEmailRouting(cf(), {
      zoneId: input.zoneId,
      config: input.config,
      workerName: input.workerName,
    });
    log.info(`Read Email Routing on ${inspection.zoneName ?? `zone ${input.zoneId}`}.`);
    return inspection;
  });
}
