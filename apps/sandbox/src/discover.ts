import {
  CLOUDFLARE_API_BASE,
  CloudflareApiError,
  type CloudflareClient,
  type CloudflareEnvelope,
  createClient,
} from "@appflare/cf-api";
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
 *
 * An installer that gives what it creates for the install fixed names (the
 * Void CLI) passes them as {@link OwnedResourceNames}: its dispatch
 * namespaces, Hyperdrive configurations and AI Gateways are then looked up
 * by those exact names (a Worker binds a namespace or a configuration, but
 * nothing names a gateway), and what its Workers bind is reported only when
 * named there, because the installed platform makes resources of its own
 * for its users, with similar names, that are not the install's.
 */

/**
 * The exact names an installer gives what it creates for one install, by
 * kind. Kinds left out are not looked up (account-wide kinds) or not
 * reported (bound kinds); Workers, Durable Object classes and Workflows come
 * from the expected Workers themselves and are not listed.
 */
export type OwnedResourceNames = Partial<
  Record<Exclude<SelfManagedResourceKind, "worker" | "durable_object" | "workflow">, string[]>
>;

/** An account-wide resource as its list reports it. */
export interface NamedResource {
  id: string;
  name: string;
}

/**
 * The Cloudflare API calls a run makes with the app token. The production
 * one wraps cf-api (and calls the few endpoints cf-api does not cover
 * directly); tests use a fake.
 */
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
  /** Workers for Platforms dispatch namespaces (`id` the namespace id). */
  dispatchNamespaces(): Promise<NamedResource[]>;
  /** Hyperdrive configurations. */
  hyperdriveConfigs(): Promise<NamedResource[]>;
  /** AI Gateways (`id` and `name` are both the gateway's id, which is its name). */
  aiGateways(): Promise<NamedResource[]>;
  /**
   * The app token's id: `GET /user/tokens/verify` for a token a user owns,
   * then `GET /accounts/{id}/tokens/verify` for one the account owns (each
   * refuses the other kind). Throws the second answer's error when neither
   * verifies it.
   */
  tokenId(): Promise<string>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

/** Page size of the AI Gateway list, read until a short page (as the Void CLI reads it). */
const AI_GATEWAY_PAGE_SIZE = 50;

/**
 * One `GET` of the Cloudflare API, envelope unwrapped, for endpoints cf-api
 * has no method for. Errors are cf-api's own, so they never carry the token.
 */
async function getResult(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  token: string,
  path: string,
): Promise<unknown> {
  const response = await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  let envelope: Partial<CloudflareEnvelope<unknown>> = {};
  try {
    envelope = (await response.json()) as Partial<CloudflareEnvelope<unknown>>;
  } catch {
    // Not the API's envelope (an edge error page); the status says what happened.
  }
  if (!response.ok || envelope.success === false) {
    const logical = path.split("?")[0] ?? path;
    throw new CloudflareApiError({
      status: response.status,
      method: "GET",
      path: logical,
      errors: Array.isArray(envelope.errors) ? envelope.errors : [],
    });
  }
  return envelope.result;
}

function rows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? result.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    : [];
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
  const get = (path: string) =>
    getResult(fetchImpl ?? ((input, init) => fetch(input, init)), token, path);
  const account = `/accounts/${accountId}`;
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
    async dispatchNamespaces() {
      // One answer with every namespace; the endpoint does not page.
      return rows(await get(`${account}/workers/dispatch/namespaces`)).flatMap((n) => {
        const id = str(n.namespace_id);
        const name = str(n.namespace_name);
        return id === null || name === null ? [] : [{ id, name }];
      });
    },
    async hyperdriveConfigs() {
      return (await api.hyperdrive.listConfigs()).map((c) => ({ id: c.id, name: c.name }));
    },
    async aiGateways() {
      const all: NamedResource[] = [];
      for (let page = 1; page <= 200; page++) {
        const found = rows(
          await get(`${account}/ai-gateway/gateways?page=${page}&per_page=${AI_GATEWAY_PAGE_SIZE}`),
        );
        for (const g of found) {
          const id = str(g.id);
          if (id !== null) all.push({ id, name: id });
        }
        if (found.length < AI_GATEWAY_PAGE_SIZE) break;
      }
      return all;
    },
    async tokenId() {
      try {
        return (await api.tokens.verifyUserToken()).id;
      } catch {
        // An account-owned token: the user endpoint refuses it.
        return (await api.tokens.verify()).id;
      }
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
  /** The binding that refers to it; null for an account-wide resource found by its name. */
  binding: string | null;
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

export interface DiscoverOptions {
  withResources: boolean;
  /**
   * The exact names of what the installer creates for the install (see
   * {@link OwnedResourceNames}). Only with `withResources`.
   */
  owned?: OwnedResourceNames | null;
}

/** Kinds found by listing the account, not through a binding. */
const ACCOUNT_WIDE_KINDS = ["dispatch_namespace", "hyperdrive", "ai_gateway"] as const;

/** Whether `owned` names the resource; Workers and what belongs to them always pass. */
export function isOwned(
  owned: OwnedResourceNames | null,
  kind: SelfManagedResourceKind,
  name: string,
): boolean {
  if (owned === null || kind === "worker" || kind === "durable_object" || kind === "workflow") {
    return true;
  }
  return owned[kind]?.includes(name) === true;
}

/**
 * The binding (and its Worker) that refers to an account-wide resource:
 * a dispatch namespace binding names its namespace, a Hyperdrive binding
 * carries the configuration's id.
 */
function bindingTo(
  bound: ReadonlyArray<{ worker: string; bindings: Binding[] }>,
  kind: "dispatch_namespace" | "hyperdrive",
  resource: NamedResource,
): { worker: string; binding: string } | null {
  for (const { worker, bindings } of bound) {
    for (const b of bindings) {
      const name = str(b.name);
      if (name === null || b.type !== kind) continue;
      const refers =
        kind === "dispatch_namespace"
          ? str(b.namespace) === resource.name
          : str(b.id) === resource.id;
      if (refers) return { worker, binding: name };
    }
  }
  return null;
}

/**
 * Reads each expected Worker and what it binds. Account-wide lists (D1
 * names, KV titles, the subdomain) are read once, only when needed.
 */
export async function discover(
  reader: AccountReader,
  expectedWorkers: readonly string[],
  opts: DiscoverOptions = { withResources: true },
): Promise<Discovery> {
  const workers: SelfManagedWorker[] = [];
  const missing: string[] = [];
  const found: Array<Found & { worker: string }> = [];
  const bound: Array<{ worker: string; bindings: Binding[] }> = [];
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
    const objects = bindings.filter(
      (raw): raw is Binding => typeof raw === "object" && raw !== null,
    );
    bound.push({ worker, bindings: objects });
    for (const raw of objects) {
      const resource = resourceOf(worker, raw);
      if (resource !== null) found.push({ ...resource, worker });
    }
  }

  const owned = opts.withResources ? (opts.owned ?? null) : null;
  if (owned !== null) {
    // What nothing binds is recorded on the Worker that serves the app.
    const home = workers[0]?.name ?? expectedWorkers[0];
    const lists = {
      dispatch_namespace: () => reader.dispatchNamespaces(),
      hyperdrive: () => reader.hyperdriveConfigs(),
      ai_gateway: () => reader.aiGateways(),
    };
    for (const kind of ACCOUNT_WIDE_KINDS) {
      const names = owned[kind] ?? [];
      if (names.length === 0) continue;
      for (const r of await lists[kind]()) {
        if (!names.includes(r.name)) continue;
        const via = kind === "ai_gateway" ? null : bindingTo(bound, kind, r);
        const worker = via?.worker ?? home;
        if (worker === undefined) continue;
        // An AI Gateway's id is its name; the others have an id of their own.
        const cfId = kind === "ai_gateway" ? null : r.id;
        found.push({ kind, name: r.name, cfId, binding: via?.binding ?? null, worker });
      }
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
    // A bound resource the installer does not name as the install's (the
    // platform's own users' resources) is not recorded.
    if (name === null || !isOwned(owned, f.kind, name)) continue;
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
