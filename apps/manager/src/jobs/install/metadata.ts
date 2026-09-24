import type {
  ScriptMetadata,
  WorkerBinding as UploadBinding,
  WorkerModule,
} from "@appflare/cf-api";
import {
  type ArtifactManifest,
  isSelfServiceBinding,
  type ModuleType,
  type PlaceholderValues,
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
  /** KV namespace id, D1 uuid, R2 bucket name, queue name, Vectorize index name. */
  name: string;
  cfId: string;
}

/**
 * Every var the install's Worker gets (`resolveVars`), with `{{workerUrl}}`
 * and `{{workerName}}` filled in from its Worker name and the account's
 * workers.dev subdomain, or from `workerUrl` when the app is reached
 * elsewhere (its custom domain while workers.dev is off). The job logs the
 * warnings: a stored value the app can no longer read falls back to the
 * default instead of failing the job.
 */
export function installVars(
  manifest: Pick<ArtifactManifest, "catalog" | "worker">,
  userVars: Readonly<Record<string, string>>,
  worker: { workerName: string; subdomain: string; workerUrl?: string },
): ResolvedVars {
  const placeholders: PlaceholderValues = {
    workerName: worker.workerName,
    workerUrl: worker.workerUrl ?? workersDevUrl(worker.workerName, worker.subdomain),
  };
  return resolveVars(manifest, userVars, placeholders);
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
): UploadBinding {
  if (!isSelfServiceBinding(binding)) {
    throw new Error(`service binding ${binding.name} does not point at the app's own Worker`);
  }
  const out: UploadBinding = { type: "service", name: binding.name, service: workerName };
  if (binding.entrypoint !== undefined) out.entrypoint = binding.entrypoint;
  return out;
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
      bindings.push(selfServiceUploadBinding(binding, workerName));
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
