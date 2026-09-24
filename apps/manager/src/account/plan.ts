import { z } from "zod";

/**
 * The account's Workers plan. Client-safe: no server imports.
 *
 * The capability probes read it from the account's subscriptions when the
 * token has the optional "Billing: Read" permission (capabilities/); an
 * admin's statement in Settings applies when they cannot tell. On Workers
 * Paid, installs and updates take the Workers Paid confirmations as given and
 * skip the count of the account's cron triggers. Neither known means free:
 * every confirmation is then asked per install.
 */

export const ACCOUNT_PLANS = ["free", "paid"] as const;
export const accountPlanSchema = z.enum(ACCOUNT_PLANS);
export type AccountPlan = z.infer<typeof accountPlanSchema>;

/** Input of the admin-only server function that records the plan. */
export const setAccountPlanInput = z.object({ plan: accountPlanSchema });
export type SetAccountPlanInput = z.infer<typeof setAccountPlanInput>;

/** The stored value, or free when it is absent or not one of the two. */
export function parseAccountPlan(value: string | null | undefined): AccountPlan {
  const parsed = accountPlanSchema.safeParse(value);
  return parsed.success ? parsed.data : "free";
}

/** Words the settings card and the confirmations use. */
export const ACCOUNT_PLAN_COPY = {
  title: "Workers plan",
  /** Legend of the manual choice, shown only while Appflare cannot detect the plan. */
  manualLegend: "Which Workers plan is this account on?",
  labels: { free: "Workers Free", paid: "Workers Paid" } satisfies Record<AccountPlan, string>,
  descriptions: {
    free: "Apps that need Workers Paid ask for a confirmation, and installs count the account's cron triggers.",
    paid: "Installs and updates skip the Workers Paid confirmations and the count of cron triggers.",
  } satisfies Record<AccountPlan, string>,
  /** Under the manual choice when the token cannot read the account's subscriptions. */
  billingHint: "Add Billing: Read to the token and Appflare detects this itself.",
  remember: "Remember this for the account",
  rememberDescription:
    "Records Workers Paid in Settings, so installs and updates stop asking while Appflare cannot detect the plan. Change it there if the plan changes.",
} as const;
