import { and, eq, isNull, ne } from "drizzle-orm";
import { createDb } from "../db/client";
import { installs, resources } from "../db/schema";
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
 *
 * `replaces` ("Install again"): the failed install the new one replaces,
 * whose removal comes first. Its own name and the Workers it recorded are
 * left out, by install, so a name another install holds stays taken.
 */
export async function takenWorkerNames(
  deps: TakenWorkerNamesDeps,
  replaces?: string,
): Promise<TakenWorkerNames> {
  const db = createDb(deps.db);
  const [rows, recorded, account] = await Promise.all([
    db
      .select({ id: installs.id, worker: installs.worker_name })
      .from(installs)
      .where(ne(installs.status, "uninstalled")),
    replaces === undefined
      ? Promise.resolve([])
      : db
          .select({ name: resources.name })
          .from(resources)
          .where(
            and(
              eq(resources.install_id, replaces),
              eq(resources.kind, "worker"),
              isNull(resources.deleted_at),
            ),
          ),
    deps.listAccountWorkers().then(
      (names) => names,
      () => null,
    ),
  ]);
  const installed = rows.filter((r) => r.id !== replaces).map((r) => r.worker);
  // Deleted before the new install starts, unless another install holds the name.
  const freed = new Set(recorded.map((r) => r.name).filter((n) => !installed.includes(n)));
  return { installed, account: account?.filter((n) => !freed.has(n)) ?? null };
}
