import { parseStoredCapabilities, resolveAccountPlan } from "../capabilities/capabilities";
import type { Database } from "../db/client";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import type { AccountPlan } from "./plan";

/**
 * The account's Workers plan in force: the one the capability probes
 * detected, else `settings.account_plan` as an admin set it, else free.
 */
export async function readAccountPlan(db: Database): Promise<AccountPlan> {
  const row = await readSettings(db, [SETTING.accountPlan, SETTING.accountCapabilities]);
  return resolveAccountPlan(row.account_plan, parseStoredCapabilities(row.account_capabilities))
    .plan;
}

/** Records the plan an admin states; it applies whenever none is detected. */
export async function writeAccountPlan(
  db: Database,
  plan: AccountPlan,
  now: Date = new Date(),
): Promise<void> {
  await writeSettings(db, { [SETTING.accountPlan]: plan }, now);
}
