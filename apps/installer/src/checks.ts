import { type CloudflareClient, isWorkflowNotFound, type Zone } from "@appflare/cf-api";
import { d1NameFor, kvTitleFor, parentNames, routeMatchesHostname, wildcardNames } from "./names";

/**
 * Whether a name and a hostname are free in the account, read the way the
 * deploy steps will meet them. Nothing is changed. The deploy steps check
 * again before each create, since the account can change in between.
 */

export type NameUse = "worker" | "database" | "storage" | "workflow";

/** What already uses the names an installation called `workerName` would create. */
export async function namesInUse(
  api: CloudflareClient,
  workerName: string,
  workflowName: string,
): Promise<NameUse[]> {
  const used: NameUse[] = [];
  const scripts = await api.workers.listScripts();
  if (scripts.some((s) => s.id === workerName)) used.push("worker");
  const databases = await api.d1.listDatabases();
  if (databases.some((d) => d.name === d1NameFor(workerName))) used.push("database");
  const namespaces = await api.kv.listNamespaces();
  if (namespaces.some((n) => n.title === kvTitleFor(workerName))) used.push("storage");
  try {
    await api.workflows.getWorkflow(workflowName);
    used.push("workflow");
  } catch (error) {
    if (!isWorkflowNotFound(error)) throw error;
  }
  return used;
}

/** Why a name is taken, in plain words, for the visitor. */
export function nameTakenMessage(
  workerName: string,
  used: readonly (NameUse | "installation")[],
): string {
  const what: Record<NameUse | "installation", string> = {
    worker: `a Worker named "${workerName}"`,
    database: `a D1 database named "${d1NameFor(workerName)}"`,
    storage: `a KV namespace named "${kvTitleFor(workerName)}"`,
    workflow: "a Workflow with the name this installation would use",
    installation: `an unfinished installation named "${workerName}" (continue or remove it instead)`,
  };
  return `This Cloudflare account already has ${used.map((u) => what[u]).join(" and ")}. Choose another name.`;
}

export type HostnameConflict = { conflict: "dns" | "worker" | "route"; detail: string };

export type HostnameCheck =
  | { kind: "free"; zone: Zone }
  /** The hostname already serves this installation's own Worker (a step that ran before). */
  | { kind: "ours"; zone: Zone; domainId: string }
  | { kind: "conflict"; zone: Zone; conflict: HostnameConflict }
  | { kind: "no-zone" };

const ADDRESS_RECORD_TYPES: ReadonlySet<string> = new Set(["A", "AAAA", "CNAME"]);

/** The account's active zones (pages of 50), for the zone picker. */
export async function activeZones(api: CloudflareClient): Promise<Zone[]> {
  const zones = await api.zones.listZones({ accountId: api.accountId, status: "active" });
  // A token can see zones of other accounts; only the account's own serve its Workers.
  return zones.filter((z) => z.account?.id === undefined || z.account.id === api.accountId);
}

/**
 * The account's active zone `hostname` belongs to: each name it ends in is
 * asked for by exact name (`GET /zones?name=&account.id=&status=active`),
 * longest first, so a subdomain zone wins over its parent. One request per
 * label at most, whatever the number of zones in the account.
 */
export async function zoneOfHostname(
  api: CloudflareClient,
  hostname: string,
): Promise<Zone | null> {
  for (const name of parentNames(hostname)) {
    const [zone] = (
      await api.zones.listZones({ accountId: api.accountId, status: "active", name })
    ).filter(
      (z) => z.name.toLowerCase() === name && (z.account?.id ?? api.accountId) === api.accountId,
    );
    if (zone !== undefined) return zone;
  }
  return null;
}

function listRecords(records: ReadonlyArray<{ type: string; content?: string }>): string {
  return records
    .slice(0, 3)
    .map((r) => (r.content ? `${r.type} ${r.content}` : r.type))
    .join(", ");
}

/**
 * Whether `hostname` is free for the Worker `workerName`: in an active zone
 * of the account (`zone` when the caller knows it), not another Worker's
 * custom domain, without DNS address records of its own or a wildcard
 * record that answers for it, and not caught by a Workers route. A custom
 * domain that already serves `workerName` is `ours` (it is the
 * installation's own Worker only once the installation created it; the
 * caller knows).
 */
export async function checkHostname(
  api: CloudflareClient,
  hostname: string,
  workerName: string,
  knownZone?: Zone,
): Promise<HostnameCheck> {
  const zone = knownZone ?? (await zoneOfHostname(api, hostname));
  if (zone === null) return { kind: "no-zone" };

  const domains = await api.workerDomains.listDomains({ hostname });
  const domain = domains.find((d) => d.hostname.toLowerCase() === hostname);
  if (domain !== undefined) {
    if (domain.service === workerName) return { kind: "ours", zone, domainId: domain.id };
    return {
      kind: "conflict",
      zone,
      conflict: {
        conflict: "worker",
        detail: `${hostname} already serves the Worker "${domain.service}".`,
      },
    };
  }

  const records = (await api.zones.listDnsRecords(zone.id, { name: hostname })).filter((r) =>
    ADDRESS_RECORD_TYPES.has(r.type),
  );
  if (records.length > 0) {
    return {
      kind: "conflict",
      zone,
      conflict: {
        conflict: "dns",
        detail: `${hostname} already has DNS records (${listRecords(records)}). Remove them in the Cloudflare dashboard or choose another name.`,
      },
    };
  }

  // A wildcard record answers for the name today; attaching it would quietly
  // take the name away from whatever the wildcard points at.
  for (const wildcard of wildcardNames(hostname, zone.name)) {
    const covering = (await api.zones.listDnsRecords(zone.id, { name: wildcard })).filter((r) =>
      ADDRESS_RECORD_TYPES.has(r.type),
    );
    if (covering.length > 0) {
      return {
        kind: "conflict",
        zone,
        conflict: {
          conflict: "dns",
          detail: `The wildcard DNS record ${wildcard} (${listRecords(covering)}) covers ${hostname}, so the name already answers through it. Choose another name, or change the wildcard record in the Cloudflare dashboard first.`,
        },
      };
    }
  }

  const routes = await api.zones.listWorkerRoutes(zone.id);
  const route = routes.find((r) => r.script && routeMatchesHostname(r.pattern, hostname));
  if (route !== undefined) {
    return {
      kind: "conflict",
      zone,
      conflict: {
        conflict: "route",
        detail: `Requests to ${hostname} already go to the Worker "${route.script}" through the route ${route.pattern}.`,
      },
    };
  }
  return { kind: "free", zone };
}
