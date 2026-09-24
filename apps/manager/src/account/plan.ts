import { z } from "zod";

/**
 * The account's Workers plan, as an admin states it in Settings. Client-safe:
 * no server imports.
 *
 * Cloudflare's API offers nothing the manager's token can read that tells
 * Workers Free from Workers Paid (the account settings and entitlements do
 * not say; subscriptions need a billing permission Appflare does not ask
 * for), so the admin says it once for the account. On Workers Paid, installs
 * and updates take the Workers Paid confirmations as given and skip the count
 * of the account's cron triggers. Absent means free: every confirmation is
 * then asked per install, as it would be without the setting.
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
  explanation:
    "Cloudflare's API does not tell Appflare which Workers plan this account is on, so an admin states it here. On Workers Paid, installs and updates skip the Workers Paid confirmations and the count of the account's cron triggers.",
  labels: { free: "Workers Free", paid: "Workers Paid" } satisfies Record<AccountPlan, string>,
  remember: "Remember this for the account",
  rememberDescription:
    "Records Workers Paid in Settings, so installs and updates stop asking. Change it there if the plan changes.",
} as const;
