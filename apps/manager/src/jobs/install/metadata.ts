import type {
  ScriptMetadata,
  WorkerBinding as UploadBinding,
  WorkerModule,
} from "@appflare/cf-api";
import type { ArtifactManifest, ModuleType, WorkerBinding } from "@appflare/schema";
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
  /** KV namespace id, D1 uuid, R2 bucket name, queue name, Vectorize index name. */
  name: string;
  cfId: string;
}

/**
 * The value of every var the app gets as a `plain_text` binding: the manifest's
 * recorded `vars` (wrangler config defaults), overridden by each catalog var's
 * user value, else its catalog `default`. A catalog var left blank with no default
 * is not sent at all.
 */
export function resolveVars(
  manifest: ArtifactManifest,
  userVars: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const binding of manifest.worker.bindings) {
    if (binding.type === "plain_text" && typeof binding.text === "string") {
      out[binding.name] = binding.text;
    }
  }
  for (const v of manifest.catalog.vars) {
    const entered = userVars[v.name];
    if (entered !== undefined && entered.length > 0) out[v.name] = entered;
    else if (v.default !== undefined) out[v.name] = v.default;
  }
  return out;
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

export interface ScriptMetadataInput {
  manifest: ArtifactManifest;
  resources: readonly CreatedResource[];
  /** Workflow binding name -> the account-wide Workflow name the install uses. */
  workflowNames?: Readonly<Record<string, string>>;
  vars: Readonly<Record<string, string>>;
  /** The assets completion JWT, or null when the artifact has no assets. */
  assetsJwt: string | null;
}

/**
 * Every binding is sent explicitly with ids filled in from `resources`; `vars`
 * become `plain_text`; the `assets` binding and `assets: { jwt, config }` go
 * together (`keep_bindings` is not used for installs; the script is new).
 */
export function buildScriptMetadata(input: ScriptMetadataInput): ScriptMetadata {
  const { manifest, resources, vars, assetsJwt, workflowNames = {} } = input;
  const byBinding = new Map(resources.map((r) => [r.binding, r]));
  const bindings: UploadBinding[] = [];

  for (const binding of manifest.worker.bindings) {
    if (binding.type === "plain_text") continue; // re-added from `vars` below
    const created = byBinding.get(binding.name);
    if (created !== undefined) {
      bindings.push(resourceBinding(binding, created));
    } else if (binding.type === "workflow") {
      const name = workflowNames[binding.name];
      if (name === undefined) throw new Error(`workflow binding ${binding.name} has no name`);
      bindings.push({ ...binding, workflow_name: name });
    } else if (PASSTHROUGH_BINDING_TYPES.has(binding.type)) {
      bindings.push({ ...binding });
    } else {
      throw new Error(`binding ${binding.name} (${binding.type}) has no created resource`);
    }
  }
  for (const [name, text] of Object.entries(vars)) {
    bindings.push({ type: "plain_text", name, text });
  }

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
  const migrations = durableObjectMigrations(manifest.worker.migrations);
  if (migrations !== undefined) metadata.migrations = migrations;
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
