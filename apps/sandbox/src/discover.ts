import { CloudflareApiError, type CloudflareClient, createClient } from "@appflare/cf-api";
import type {
  SelfManagedResource,
  SelfManagedResourceKind,
  SelfManagedWorker,
} from "@appflare/schema";

/**
 * What a self-deploying app's installer created, read back from the account
 * with the app's own token (never the manager's): each expected Worker, its
 * workers.dev URL, and the resources it binds. The installer's output is not
 * parsed; the account is the record. Only resources that belong to the
 * Workers are reported: a Durable Object class or Workflow another script
 * implements is that script's, and service, variable, secret and asset
 * bindings are not resources.
 */

/** The account calls discovery makes. The production one wraps cf-api; tests use a fake. */
export interface AccountReader {
  /** The Worker's bindings, or null when there is no such Worker. */
  workerBindings(worker: string): Promise<unknown[] | null>;
  /** Whether the Worker's workers.dev route is on. */
  workersDevEnabled(worker: string): Promise<boolean>;
  /** The account's workers.dev subdomain (`<name>`, without `.workers.dev`). */
  accountSubdomain(): Promise<string>;
  /** D1 database names by id. */
  d1Names(): Promise<Map<string, string>>;
  /** KV namespace titles by id. */
  kvTitles(): Promise<Map<string, string>>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

/** An {@link AccountReader} over the Cloudflare API with `token`. */
export function accountReader(
  token: string,
  accountId: string,
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>,
): AccountReader {
  const api: CloudflareClient = createClient({
    accountId,
    token,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  return {
    async workerBindings(worker) {
      try {
        return await api.workers.getBindings(worker);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async workersDevEnabled(worker) {
      return (await api.workers.getSubdomain(worker)).enabled;
    },
    async accountSubdomain() {
      return (await api.workers.getAccountSubdomain()).subdomain;
    },
    async d1Names() {
      return new Map((await api.d1.listDatabases()).map((d) => [d.uuid, d.name]));
    },
    async kvTitles() {
      return new Map((await api.kv.listNamespaces()).map((n) => [n.id, n.title]));
    },
  };
}

type Binding = Record<string, unknown> & { type?: unknown; name?: unknown };

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface Found {
  kind: SelfManagedResourceKind;
  name: string | null;
  cfId: string | null;
  binding: string;
  /** Needs a name looked up by id (D1 and KV bindings carry only ids). */
  lookup?: "d1" | "kv";
}

/** The resource a binding points at, when it is one the Worker owns. */
function resourceOf(worker: string, b: Binding): Found | null {
  const binding = str(b.name);
  if (binding === null) return null;
  const owner = str(b.script_name) ?? worker;
  switch (b.type) {
    case "d1": {
      const id = str(b.id) ?? str(b.database_id);
      return id === null ? null : { kind: "d1", name: null, cfId: id, binding, lookup: "d1" };
    }
    case "kv_namespace": {
      const id = str(b.namespace_id);
      return id === null ? null : { kind: "kv", name: null, cfId: id, binding, lookup: "kv" };
    }
    case "r2_bucket": {
      const bucket = str(b.bucket_name);
      return bucket === null ? null : { kind: "r2", name: bucket, cfId: bucket, binding };
    }
    case "queue": {
      const queue = str(b.queue_name);
      return queue === null ? null : { kind: "queue", name: queue, cfId: null, binding };
    }
    case "vectorize": {
      const index = str(b.index_name);
      return index === null ? null : { kind: "vectorize", name: index, cfId: null, binding };
    }
    case "durable_object_namespace": {
      const className = str(b.class_name);
      if (className === null || owner !== worker) return null;
      return {
        kind: "durable_object",
        name: className,
        cfId: str(b.namespace_id),
        binding,
      };
    }
    case "workflow": {
      const name = str(b.workflow_name);
      if (name === null || owner !== worker) return null;
      return { kind: "workflow", name, cfId: null, binding };
    }
    default:
      return null;
  }
}

export interface Discovery {
  /** The expected Workers that exist, in the order asked. */
  workers: SelfManagedWorker[];
  /** Expected Workers the account does not have. */
  missing: string[];
  resources: SelfManagedResource[];
}

/**
 * Reads each expected Worker and what it binds. Account-wide lists (D1
 * names, KV titles, the subdomain) are read once, only when needed.
 */
export async function discover(
  reader: AccountReader,
  expectedWorkers: readonly string[],
  opts: { withResources: boolean } = { withResources: true },
): Promise<Discovery> {
  const workers: SelfManagedWorker[] = [];
  const missing: string[] = [];
  const found: Array<Found & { worker: string }> = [];
  let subdomain: string | null = null;
  for (const worker of expectedWorkers) {
    const bindings = await reader.workerBindings(worker);
    if (bindings === null) {
      missing.push(worker);
      continue;
    }
    let url: string | null = null;
    if (await reader.workersDevEnabled(worker)) {
      subdomain ??= await reader.accountSubdomain();
      url = `https://${worker}.${subdomain}.workers.dev`;
    }
    workers.push({ name: worker, url });
    if (!opts.withResources) continue;
    for (const raw of bindings) {
      if (typeof raw !== "object" || raw === null) continue;
      const resource = resourceOf(worker, raw as Binding);
      if (resource !== null) found.push({ ...resource, worker });
    }
  }

  const d1 = found.some((f) => f.lookup === "d1") ? await reader.d1Names() : new Map();
  const kv = found.some((f) => f.lookup === "kv") ? await reader.kvTitles() : new Map();
  const resources: SelfManagedResource[] = workers.map((w) => ({
    kind: "worker",
    name: w.name,
    cfId: w.name,
    worker: w.name,
    binding: null,
  }));
  const seen = new Set(resources.map((r) => `worker:${r.name}`));
  for (const f of found) {
    const looked = f.lookup === "d1" ? d1 : f.lookup === "kv" ? kv : null;
    const name = f.name ?? (f.cfId === null ? null : (looked?.get(f.cfId) ?? f.cfId));
    if (name === null) continue;
    // Shared resources (both Workers bind one database) are reported once;
    // Durable Object classes are per Worker.
    const key =
      f.kind === "durable_object" ? `${f.kind}:${f.worker}:${name}` : `${f.kind}:${f.cfId ?? name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resources.push({ kind: f.kind, name, cfId: f.cfId, worker: f.worker, binding: f.binding });
  }
  return { workers, missing, resources };
}
