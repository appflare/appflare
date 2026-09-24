import type { Database } from "../db/client";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { type AccountPlan, parseAccountPlan } from "./plan";

/** The account's Workers plan from `settings.account_plan`; free when never set. */
export async function readAccountPlan(db: Database): Promise<AccountPlan> {
  return parseAccountPlan((await readSettings(db, [SETTING.accountPlan])).account_plan);
}

/** Records the account's Workers plan. */
export async function writeAccountPlan(
  db: Database,
  plan: AccountPlan,
  now: Date = new Date(),
): Promise<void> {
  await writeSettings(db, { [SETTING.accountPlan]: plan }, now);
}
