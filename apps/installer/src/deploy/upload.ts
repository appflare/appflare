import type {
  ScriptMetadata,
  WorkerBinding as UploadBinding,
  WorkerModule,
} from "@appflare/cf-api";
import type { ArtifactManifest, ModuleType } from "@appflare/schema";
import { HANDOFF_SECRET, INSTALL_SOURCE_VAR, INSTALLER_ORIGIN_VAR } from "../release/manifest";

/**
 * The script upload of the manager: the release's own Worker settings and
 * bindings, with the resources this installation created, two plain-text
 * vars that tell the manager it was installed from the browser and by whom,
 * and the handoff secret. No `SELF` binding: the manager adds the binding to
 * itself with its first self-update, as it does when the release is
 * installed any other way. No other secret: the manager makes its own auth
 * secret and credential key, which this installer never sees.
 */

export interface UploadResources {
  workerName: string;
  d1Id: string;
  kvId: string;
  workflowName: string;
  /** `https://appflare.dev`. */
  installerOrigin: string;
  handoffHash: string;
  /** The assets completion token, or null when the release has no static files. */
  assetsJwt: string | null;
}

export function handoffSecretValue(handoffHash: string): string {
  return `v1.${handoffHash}`;
}

/**
 * Binding types the upload keeps from the Worker's current version when it
 * replaces one: secrets the manager has written to itself survive a repeated
 * upload of this step.
 */
const KEPT_BINDING_TYPES = ["secret_text", "secret_key"];

export function managerMetadata(manifest: ArtifactManifest, r: UploadResources): ScriptMetadata {
  const { worker } = manifest;
  if (worker.mainModule === undefined) throw new Error("the release has no Worker code");
  const bindings: UploadBinding[] = [];
  for (const binding of worker.bindings) {
    switch (binding.type) {
      case "d1":
        bindings.push({ type: "d1", name: binding.name, id: r.d1Id });
        break;
      case "kv_namespace":
        bindings.push({ type: "kv_namespace", name: binding.name, namespace_id: r.kvId });
        break;
      case "workflow":
        bindings.push({
          type: "workflow",
          name: binding.name,
          workflow_name: r.workflowName,
          class_name: String(binding.class_name),
        });
        break;
      case "version_metadata":
      case "plain_text":
      case "json":
        bindings.push({ ...binding });
        break;
      case "service":
        // The manager's binding to itself; it adds that on its own.
        break;
      default:
        throw new Error(`the release has a ${binding.type} binding`);
    }
  }
  bindings.push(
    { type: "plain_text", name: INSTALLER_ORIGIN_VAR, text: r.installerOrigin },
    { type: "plain_text", name: INSTALL_SOURCE_VAR, text: "browser" },
    { type: "secret_text", name: HANDOFF_SECRET, text: handoffSecretValue(r.handoffHash) },
  );
  const metadata: ScriptMetadata = {
    main_module: worker.mainModule,
    compatibility_date: worker.compatibilityDate,
    compatibility_flags: [...worker.compatibilityFlags],
    bindings,
    keep_bindings: KEPT_BINDING_TYPES,
  };
  if (r.assetsJwt !== null) {
    if (manifest.assets.binding) bindings.push({ type: "assets", name: manifest.assets.binding });
    metadata.assets = { jwt: r.assetsJwt, config: { ...manifest.assets.config } };
  }
  if (worker.cacheOptions !== undefined) metadata.cache_options = { ...worker.cacheOptions };
  if (worker.observability) {
    metadata.observability = worker.observability as ScriptMetadata["observability"];
  }
  if (worker.placement) metadata.placement = worker.placement as ScriptMetadata["placement"];
  if (worker.limits) metadata.limits = worker.limits as ScriptMetadata["limits"];
  return metadata;
}

/** Module part content types, as wrangler 4.136.2's `moduleTypeMimeType`. */
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
