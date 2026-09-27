import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { createDb } from "../db/client";
import { requireRole } from "../server/auth.server";
import { type AccountPlan, setAccountPlanInput } from "./plan";
import { writeAccountPlan } from "./plan.server";

/**
 * The Workers plan an admin chooses on Your account ("Choose plan"): only
 * admins set it. Reading it is part of the account capabilities
 * (capabilities/), which also say whether the plan in force was detected
 * or set here.
 */
export const setAccountPlan = createServerFn({ method: "POST" })
  .validator(setAccountPlanInput)
  .handler(async ({ data }): Promise<AccountPlan> => {
    await requireRole("admin");
    await writeAccountPlan(createDb(env.DB), data.plan);
    return data.plan;
  });
