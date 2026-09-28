import { ne } from "drizzle-orm";
import { createDb } from "../db/client";
import { installs } from "../db/schema";
import type { TakenWorkerNames } from "./worker-name-check";

export interface TakenWorkerNamesDeps {
  db: D1Database;
  /** Every Worker in the account (`GET /workers/scripts`, one call). */
  listAccountWorkers(): Promise<string[]>;
}

/**
 * The Worker names the install form's live check refuses: those of apps
 * installed here (read from D1, so an install still being set up counts),
 * and every Worker in the account. Best effort for the account: when it
 * cannot be listed, `account` is null and the form checks the format only;
 * starting the install checks the account again.
 */
export async function takenWorkerNames(deps: TakenWorkerNamesDeps): Promise<TakenWorkerNames> {
  const [rows, account] = await Promise.all([
    createDb(deps.db)
      .select({ worker: installs.worker_name })
      .from(installs)
      .where(ne(installs.status, "uninstalled")),
    deps.listAccountWorkers().then(
      (names) => names,
      () => null,
    ),
  ]);
  return { installed: rows.map((r) => r.worker), account };
}
