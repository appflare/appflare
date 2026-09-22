import type { ScriptMetadata, VersionMetadata } from "./types";

/**
 * The five module content types Cloudflare's multipart script upload recognizes,
 * keyed by module type, matching wrangler 4.136.2's `moduleTypeMimeType`. `esm` is
 * the one the manager actually uses (Workers ship as ES modules). Pass an explicit
 * {@link WorkerModule.contentType} to override any default.
 */
export const MODULE_CONTENT_TYPES = {
  esm: "application/javascript+module",
  commonjs: "application/javascript",
  "compiled-wasm": "application/wasm",
  text: "text/plain",
  buffer: "application/octet-stream",
} as const satisfies Record<string, string>;

export type WorkerModuleType = keyof typeof MODULE_CONTENT_TYPES;

/** One module part of a script or version upload. */
export interface WorkerModule {
  /** Module specifier; used as both the form-field name and the filename. */
  name: string;
  content: string | ArrayBuffer | Uint8Array | Blob;
  /** Selects a default content type; defaults to `esm`. */
  type?: WorkerModuleType;
  /** Explicit content type, overriding {@link MODULE_CONTENT_TYPES}. */
  contentType?: string;
}

function contentTypeFor(module: WorkerModule): string {
  return module.contentType ?? MODULE_CONTENT_TYPES[module.type ?? "esm"];
}

/**
 * Builds the `multipart/form-data` body shared by `uploadScript` (metadata =
 * {@link ScriptMetadata}) and `uploadVersion` (metadata = {@link VersionMetadata}):
 * a `metadata` JSON field plus one part per module, each a `Blob` whose content
 * type signals its module type. The `Content-Type` header (with boundary) is set
 * by fetch when this body is sent, not here.
 */
export function buildUploadFormData(
  metadata: ScriptMetadata | VersionMetadata,
  modules: WorkerModule[],
): FormData {
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  for (const module of modules) {
    // Type-only cast: under the DOM lib (the manager's typecheck compiles this file
    // from source) `BlobPart` requires `Uint8Array<ArrayBuffer>`, and a
    // `Uint8Array<ArrayBufferLike>` is rejected even though every runtime accepts it.
    const parts = [module.content] as ConstructorParameters<typeof Blob>[0];
    const blob = new Blob(parts, { type: contentTypeFor(module) });
    form.append(module.name, blob, module.name);
  }
  return form;
}
