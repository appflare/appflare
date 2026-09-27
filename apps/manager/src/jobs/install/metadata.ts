import type {
  ScriptMetadata,
  WorkerBinding as UploadBinding,
  WorkerModule,
} from "@appflare/cf-api";
import {
  type ArtifactManifest,
  type EntryWorkerPlaceholders,
  entryWorkerRefName,
  hasDurableObjectExports,
  isEntryServiceBinding,
  isSelfServiceBinding,
  type JsonValue,
  type ModuleType,
  type PlaceholderValues,
  renderEntryWorkerPlaceholders,
  type WorkerBinding,
} from "@appflare/schema";
import { type ResolvedVars, resolveVars, type VarBinding } from "../../installs/install-vars";
import { workersDevUrl } from "../../installs/post-install";
import { PASSTHROUGH_BINDING_TYPES, type ResourceBindingType } from "./bindings";

/**
 * The script upload's metadata, built from the artifact
 * manifest, the resources the job created, and the user's vars. Shapes follow
 * wrangler 4.136.2's `createWorkerUploadForm` (verified in its bundled
 * `wrangler-dist/cli.js`) and uploads tested against the live API.
 */

/** A created resource as the metadata needs it. */
export interface CreatedResource {
  binding: string;
  type: ResourceBindingType;
  /** KV namespace id, D1 uuid, R2 bucket name, queue name, Vectorize index or Hyperdrive configuration name. */
  name: string;
  cfId: string;
}

/**
 * Every var the install's Worker gets (`resolveVars`), with `{{workerUrl}}`
 * and `{{workerName}}` filled in from its Worker name and the account's
 * workers.dev subdomain, or from `workerUrl` when the app is reached
 * elsewhere (its custom domain while workers.dev is off), and `{{accountId}}`
 * from the account the job works in. The job logs the warnings: a stored
 * value the app can no longer read falls back to the default instead of
 * failing the job.
 */
export function installVars(
  manifest: Pick<ArtifactManifest, "catalog" | "worker">,
  userVars: Readonly<Record<string, string>>,
  worker: {
    workerName: string;
    subdomain: string;
    accountId: string;
    workerUrl?: string;
    /**
     * For an app of several Workers: what `{{workerUrl:<name>}}` and
     * `{{workerName:<name>}}` are filled in with (`entryPlaceholders`).
     */
    entryWorkers?: EntryWorkerPlaceholders;
  },
): ResolvedVars {
  const placeholders: PlaceholderValues = {
    workerName: worker.workerName,
    workerUrl: worker.workerUrl ?? workersDevUrl(worker.workerName, worker.subdomain),
    accountId: worker.accountId,
  };
  const resolved = resolveVars(manifest, userVars, placeholders);
  const entry = worker.entryWorkers;
  if (entry === undefined) return resolved;
  return { ...resolved, vars: resolved.vars.map((v) => renderEntryVar(v, entry)) };
}

/** A var with `{{workerUrl:<name>}}` and `{{workerName:<name>}}` filled in. */
function renderEntryVar(v: VarBinding, entry: EntryWorkerPlaceholders): VarBinding {
  const render = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return renderEntryWorkerPlaceholders(value, entry);
    if (Array.isArray(value)) return value.map(render);
    if (value !== null && typeof value === "object") {
      const out: { [key: string]: JsonValue } = {};
      for (const [key, item] of Object.entries(value)) {
        // Plain assignment of `__proto__` would set the prototype instead.
        Object.defineProperty(out, key, {
          value: render(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return value;
  };
  return v.type === "json"
    ? { ...v, json: render(v.json) }
    : { ...v, text: renderEntryWorkerPlaceholders(v.text, entry) };
}

function resourceBinding(binding: WorkerBinding, created: CreatedResource): UploadBinding {
  switch (created.type) {
    case "kv_namespace":
      return { type: "kv_namespace", name: binding.name, namespace_id: created.cfId };
    case "d1":
      return { type: "d1", name: binding.name, id: created.cfId };
    case "r2_bucket":
      return { type: "r2_bucket", name: binding.name, bucket_name: created.name };
    case "queue": {
      const out: UploadBinding = { type: "queue", name: binding.name, queue_name: created.name };
      if (typeof binding.delivery_delay === "number") out.delivery_delay = binding.delivery_delay;
      return out;
    }
    case "vectorize":
      return { type: "vectorize", name: binding.name, index_name: created.name };
    case "hyperdrive":
      // `workers_binding_kind_hyperdrive`: `{ type, name, id }`, the configuration's id.
      return { type: "hyperdrive", name: binding.name, id: created.cfId };
  }
}

/** Durable Object migrations for a fresh script, as wrangler sends them. */
export function durableObjectMigrations(
  migrations: ArtifactManifest["worker"]["migrations"],
): { new_tag: string; steps: Record<string, unknown>[] } | undefined {
  const last = migrations.at(-1);
  if (last === undefined) return undefined;
  return {
    new_tag: last.tag,
    steps: migrations.map(({ tag: _tag, ...rest }) => rest),
  };
}

/**
 * A service binding to the app's own Worker as the upload sends it: aimed at
 * `workerName`, the install's Worker, whatever name the artifact was built
 * under. Throws for any other service binding (the install and update plans
 * refuse those first; see `planBindings`), so nothing but the typed self
 * binding can ever reach an upload.
 */
export function selfServiceUploadBinding(
  binding: WorkerBinding,
  workerName: string,
  entryWorkers: Readonly<Record<string, string>> = {},
): UploadBinding {
  let service: string;
  if (isSelfServiceBinding(binding)) {
    service = workerName;
  } else if (isEntryServiceBinding(binding)) {
    // Another Worker of the app: the name it was installed under.
    const target = entryWorkerName(entryWorkers, binding.service, binding.name);
    service = target;
  } else {
    throw new Error(`service binding ${binding.name} does not point at the app's own Worker`);
  }
  const out: UploadBinding = { type: "service", name: binding.name, service };
  if (binding.entrypoint !== undefined) out.entrypoint = binding.entrypoint;
  return out;
}

/**
 * The installed Worker a `{{workerName:<name>}}` reference names. Throws when
 * the app has no such Worker (the plans refuse that first).
 */
function entryWorkerName(
  entryWorkers: Readonly<Record<string, string>>,
  ref: unknown,
  binding: string,
): string {
  const name = entryWorkerRefName(ref);
  const target =
    name !== null && Object.hasOwn(entryWorkers, name) ? entryWorkers[name] : undefined;
  if (target === undefined) {
    throw new Error(`binding ${binding} names a Worker the app does not have`);
  }
  return target;
}

export interface ScriptMetadataInput {
  manifest: ArtifactManifest;
  /** The install's Worker: where a service binding to the app's own Worker points. */
  workerName: string;
  resources: readonly CreatedResource[];
  /** Workflow binding name -> the account-wide Workflow name the install uses. */
  workflowNames?: Readonly<Record<string, string>>;
  /** Every var the Worker gets (`resolveVars` in installs/install-vars.ts). */
  vars: readonly VarBinding[];
  /** The assets completion JWT, or null when the artifact has no assets. */
  assetsJwt: string | null;
  /** Rate limit binding name -> the install's own namespace id (install/rate-limits.ts). */
  rateLimitIds?: Readonly<Record<string, string>>;
  /**
   * For an app of several Workers: each Worker's name within the entry to the
   * Worker name it is installed under (`entryScriptNames`), for bindings that
   * name another Worker of the app.
   */
  entryWorkers?: Readonly<Record<string, string>>;
}

/**
 * Every binding is sent explicitly with ids filled in from `resources`; vars
 * come from `vars` only (`plain_text` or `json`, placeholders filled in); the `assets` binding and `assets: { jwt, config }` go
 * together (`keep_bindings` is not used for installs; the script is new).
 */
export function buildScriptMetadata(input: ScriptMetadataInput): ScriptMetadata {
  const {
    manifest,
    workerName,
    resources,
    vars,
    assetsJwt,
    workflowNames = {},
    rateLimitIds = {},
    entryWorkers = {},
  } = input;
  const byBinding = new Map(resources.map((r) => [r.binding, r]));
  const bindings: UploadBinding[] = [];

  for (const binding of manifest.worker.bindings) {
    // Vars are re-added from `vars` below, with the install's values.
    if (binding.type === "plain_text" || binding.type === "json") continue;
    const created = byBinding.get(binding.name);
    if (created !== undefined) {
      bindings.push(resourceBinding(binding, created));
    } else if (binding.type === "workflow") {
      const name = workflowNames[binding.name];
      if (name === undefined) throw new Error(`workflow binding ${binding.name} has no name`);
      bindings.push({ ...binding, workflow_name: name });
    } else if (binding.type === "ratelimit") {
      // Never the artifact's id: counters are shared by every Worker binding it.
      const namespaceId = rateLimitIds[binding.name];
      if (namespaceId === undefined) {
        throw new Error(`rate limit binding ${binding.name} has no namespace of its own`);
      }
      bindings.push({ ...binding, namespace_id: namespaceId });
    } else if (binding.type === "service") {
      bindings.push(selfServiceUploadBinding(binding, workerName, entryWorkers));
    } else if (
      binding.type === "durable_object_namespace" &&
      entryWorkerRefName(binding.script_name) !== null
    ) {
      // A class in another Worker of the app, which is installed under its own name.
      bindings.push({
        ...binding,
        script_name: entryWorkerName(entryWorkers, binding.script_name, binding.name),
      });
    } else if (PASSTHROUGH_BINDING_TYPES.has(binding.type)) {
      bindings.push({ ...binding });
    } else {
      throw new Error(`binding ${binding.name} (${binding.type}) has no created resource`);
    }
  }
  for (const v of vars) bindings.push({ ...v });

  const metadata: ScriptMetadata = {
    main_module: manifest.worker.mainModule,
    compatibility_date: manifest.worker.compatibilityDate,
    compatibility_flags: manifest.worker.compatibilityFlags,
    bindings,
  };
  if (assetsJwt !== null) {
    if (manifest.assets.binding) bindings.push({ type: "assets", name: manifest.assets.binding });
    metadata.assets = { jwt: assetsJwt, config: { ...manifest.assets.config } };
  }
  // Declarative Durable Object exports replace migrations: wrangler 4.136.2
  // (`resolveDoLifecyclePayload`) sends no migrations when there are any.
  const { exports, cacheOptions } = manifest.worker;
  const migrations = hasDurableObjectExports(exports)
    ? undefined
    : durableObjectMigrations(manifest.worker.migrations);
  if (migrations !== undefined) metadata.migrations = migrations;
  if (exports !== undefined && Object.keys(exports).length > 0) metadata.exports = { ...exports };
  // A versioned setting: sent with every script and version upload, as wrangler does.
  if (cacheOptions !== undefined) metadata.cache_options = { ...cacheOptions };
  if (manifest.worker.observability) {
    metadata.observability = manifest.worker.observability as ScriptMetadata["observability"];
  }
  if (manifest.worker.placement) {
    metadata.placement = manifest.worker.placement as ScriptMetadata["placement"];
  }
  if (manifest.worker.limits) {
    metadata.limits = manifest.worker.limits as ScriptMetadata["limits"];
  }
  return metadata;
}

/** Module part content types, matching wrangler 4.136.2's `moduleTypeMimeType`. */
const MODULE_CONTENT_TYPE: Record<ModuleType, string> = {
  esm: "application/javascript+module",
  commonjs: "application/javascript",
  "compiled-wasm": "application/wasm",
  text: "text/plain",
  data: "application/octet-stream",
  python: "text/x-python",
  "python-requirement": "text/x-python-requirement",
};

export function uploadModule(
  module: { name: string; type: ModuleType },
  content: Uint8Array,
): WorkerModule {
  return { name: module.name, content, contentType: MODULE_CONTENT_TYPE[module.type] };
}
