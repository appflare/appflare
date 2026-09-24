import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { createDb } from "../db/client";
import { requireRole, requireSession } from "../server/auth.server";
import { type AccountPlan, setAccountPlanInput } from "./plan";
import { readAccountPlan, writeAccountPlan } from "./plan.server";

/** Settings, Workers plan: any signed-in user reads it; only admins change it. */

export const getAccountPlan = createServerFn({ method: "GET" }).handler(
  async (): Promise<AccountPlan> => {
    await requireSession();
    return readAccountPlan(createDb(env.DB));
  },
);

export const setAccountPlan = createServerFn({ method: "POST" })
  .validator(setAccountPlanInput)
  .handler(async ({ data }): Promise<AccountPlan> => {
    await requireRole("admin");
    await writeAccountPlan(createDb(env.DB), data.plan);
    return data.plan;
  });
