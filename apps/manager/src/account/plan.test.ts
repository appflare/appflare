import { describe, expect, it } from "vitest";
import { ACCOUNT_PLAN_COPY, parseAccountPlan, setAccountPlanInput } from "./plan";

describe("the account's Workers plan", () => {
  it("reads free unless the stored value says paid", () => {
    expect(parseAccountPlan("paid")).toBe("paid");
    expect(parseAccountPlan("free")).toBe("free");
    expect(parseAccountPlan(undefined)).toBe("free");
    expect(parseAccountPlan(null)).toBe("free");
    expect(parseAccountPlan("enterprise")).toBe("free");
  });

  it("accepts only the two plans as input", () => {
    expect(setAccountPlanInput.parse({ plan: "paid" })).toEqual({ plan: "paid" });
    expect(setAccountPlanInput.safeParse({ plan: "business" }).success).toBe(false);
    expect(setAccountPlanInput.safeParse({}).success).toBe(false);
  });

  it("explains where the plan comes from, and what it changes", () => {
    expect(ACCOUNT_PLAN_COPY.title).toBe("Workers plan");
    expect(ACCOUNT_PLAN_COPY.explanation).toBe(
      "Appflare reads the Workers plan from the account's subscriptions when the Cloudflare token has the optional Billing: Read permission. When it cannot, the plan an admin sets here applies. On Workers Paid, installs and updates skip the Workers Paid confirmations and the count of the account's cron triggers.",
    );
    expect(ACCOUNT_PLAN_COPY.labels).toEqual({ free: "Workers Free", paid: "Workers Paid" });
    expect(ACCOUNT_PLAN_COPY.remember).toBe("Remember this for the account");
  });
});
