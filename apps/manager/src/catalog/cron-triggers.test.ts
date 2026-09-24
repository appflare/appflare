import { describe, expect, it } from "vitest";
import {
  cronTriggerCount,
  cronTriggersNote,
  FREE_PLAN_CRON_TRIGGERS,
  WORKERS_PAID_CRON_CONFIRMATION,
} from "./cron-triggers";

describe("cronTriggersNote", () => {
  it("says how many cron triggers the app uses against the free plan's limit", () => {
    expect(cronTriggersNote(3)).toBe("Uses 3 cron triggers (the free plan allows 5 per account)");
    expect(cronTriggersNote(1)).toBe("Uses 1 cron trigger (the free plan allows 5 per account)");
  });

  it("says nothing for an app without cron triggers", () => {
    expect(cronTriggersNote(0)).toBeNull();
  });

  it("offers the Workers Paid confirmation with the limits it changes", () => {
    expect(WORKERS_PAID_CRON_CONFIRMATION.label).toBe("This account is on Workers Paid");
    expect(WORKERS_PAID_CRON_CONFIRMATION.description).toBe(
      "Workers Paid allows 1,000 cron triggers per account. Otherwise Appflare counts the cron triggers the account already uses and stops before it changes anything if this would pass 5.",
    );
    expect(FREE_PLAN_CRON_TRIGGERS).toBe(5);
  });
});

describe("cronTriggerCount", () => {
  it("counts each distinct schedule once, as Cloudflare stores them", () => {
    expect(cronTriggerCount(["0 1 * * *", "*/5 * * * *", "0 1 * * *"])).toBe(2);
    expect(cronTriggerCount([])).toBe(0);
  });
});
