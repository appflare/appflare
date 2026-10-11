import type { AccountNames } from "./redact";

/**
 * This manager's own names, which every text leaving it is cleaned of
 * (`redactReportText`): the hostnames recorded anywhere in it (the apps'
 * domains, and Appflare's own custom domain with the ones it had before; its
 * workers.dev addresses are covered by the subdomain and Worker name), every
 * Worker name, every other resource's name (databases, namespaces, buckets,
 * queues, Access applications), the names admins gave the apps, and the
 * account's workers.dev subdomain.
 */

/** Resource kinds whose name is (or starts with) a hostname. */
const HOSTNAME_KINDS = [
  "domain",
  "custom_hostname",
  "wildcard_domain",
  "dns_record",
  "worker_route",
] as const;

/**
 * The reads, for a caller that batches them with its own: hostnames, Worker
 * names, then every other name.
 */
export function accountNamesStatements(
  db: D1Database,
): [D1PreparedStatement, D1PreparedStatement, D1PreparedStatement] {
  return [
    // D1 allows at most five terms in a compound SELECT; the moves' hostnames share one.
    db.prepare(
      `SELECT name FROM resources WHERE kind IN (${HOSTNAME_KINDS.map((k) => `'${k}'`).join(", ")})
       UNION SELECT served_domain FROM installs WHERE served_domain IS NOT NULL
       UNION SELECT value FROM settings
         WHERE key IN ('manager_hostname', 'manager_previous_hostname')
           AND value NOT LIKE '%.workers.dev'
       UNION SELECT hostname FROM passkey_host WHERE hostname NOT LIKE '%.workers.dev'
       UNION SELECT h.value FROM jobs j,
           json_each(json_array(json_extract(j.input_json, '$.hostname'), json_extract(j.input_json, '$.from'))) h
         WHERE j.kind = 'move_address' AND json_valid(j.input_json)`,
    ),
    db.prepare(
      `SELECT worker_name AS name FROM installs
       UNION SELECT name FROM resources WHERE kind = 'worker'`,
    ),
    db.prepare(
      `SELECT name FROM resources
       WHERE kind NOT IN ('worker', ${HOSTNAME_KINDS.map((k) => `'${k}'`).join(", ")})
       UNION SELECT display_name FROM installs WHERE display_name IS NOT NULL`,
    ),
  ];
}

/** The names one of those reads answered with. */
export function namesOf(result: D1Result | undefined): string[] {
  return ((result?.results ?? []) as Record<string, unknown>[])
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/** The settings the account's names take the subdomain and Appflare's own Worker name from. */
export interface NameSettings {
  account_subdomain?: string;
  worker_name?: string;
}

/** The account's names: what those reads answered with, and the two from settings. */
export function accountNames(
  settings: NameSettings,
  hostnames: readonly string[],
  workers: readonly string[],
  names: readonly string[] = [],
): AccountNames {
  return {
    subdomain: settings.account_subdomain || null,
    hostnames,
    workers: settings.worker_name ? [...workers, settings.worker_name] : workers,
    names,
  };
}

/** The account's names as one read. */
export async function readAccountNames(
  db: D1Database,
  settings: NameSettings,
): Promise<AccountNames> {
  const [hostnames, workers, names] = await db.batch(accountNamesStatements(db));
  return accountNames(settings, namesOf(hostnames), namesOf(workers), namesOf(names));
}
