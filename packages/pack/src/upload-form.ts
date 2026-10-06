import { readFileSync } from "node:fs";
import path from "node:path";
import type { ModuleType } from "@appflare/schema";

/**
 * The artifact's module type for each content type wrangler 4.136.2 gives a
 * module part of the script upload (`moduleTypeMimeType` in workers-sdk
 * `packages/deploy-helpers/src/deploy/helpers/create-worker-upload-form.ts`).
 * The manager sends each module back with the same content type, so a
 * module reaches the Worker as the type wrangler would have uploaded it as.
 */
const MODULE_TYPE_BY_CONTENT_TYPE: Readonly<Record<string, ModuleType>> = {
  "application/javascript+module": "esm",
  "application/javascript": "commonjs",
  "application/wasm": "compiled-wasm",
  "application/octet-stream": "data",
  "text/plain": "text",
  "text/x-python": "python",
  "text/x-python-requirement": "python-requirement",
};

/** Source maps wrangler attaches with `upload_source_maps`; the artifact carries none. */
const SOURCE_MAP_CONTENT_TYPE = "application/source-map";

/** One module of a Worker as wrangler would upload it. */
export interface UploadModule {
  /** Its name in the upload, without wrangler's leading `./`. */
  name: string;
  type: ModuleType;
  bytes: Buffer;
  isMain: boolean;
}

/** The upload a dry run wrote is one the packer cannot carry, or not an upload at all. */
export class UploadFormError extends Error {
  override name = "UploadFormError";
}

/**
 * A module name as the artifact records it: wrangler names a module it
 * collected from an import `./<hash>-<file>`, which the packer has always
 * recorded as `<hash>-<file>` (the name it has in the dry run's outdir).
 * A name that leads out of the Worker's directory throws: the artifact
 * keeps every module under `worker/`.
 */
function moduleName(raw: string): string {
  const name = path.posix.normalize(raw.replaceAll("\\", "/"));
  if (name === "." || name.startsWith("../") || name === ".." || path.posix.isAbsolute(name)) {
    throw new UploadFormError(
      `wrangler names a module ${JSON.stringify(raw)}, outside the Worker's own directory, ` +
        "which the artifact cannot hold (preserve_file_names with an import from a parent directory)",
    );
  }
  return name;
}

/** The content type of a part without its parameters, lower case. */
function bareContentType(type: string): string {
  return (type.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * Reads the script upload `wrangler deploy --dry-run --outfile <file>` wrote
 * (the multipart form wrangler would send to Cloudflare, serialized) and
 * returns the Worker's modules as wrangler would upload them: each module
 * part's name, bytes and type (taken from its content type, so the config's
 * module `rules` and wrangler's default rules decide it exactly as they
 * decide the upload), the main module (the metadata's `main_module`) first
 * and the rest by name. Source maps are left out. A Worker of static assets
 * only has no modules.
 *
 * Throws {@link UploadFormError} for a service-worker Worker (the metadata
 * names a `body_part`, not a `main_module`): Appflare uploads ES module
 * Workers only. Also for a module part of a content type wrangler does not
 * give modules, or one with no main module among the parts.
 */
export async function readUploadForm(file: string): Promise<UploadModule[]> {
  const bytes = readFileSync(file);
  const firstLine = bytes.subarray(0, Math.max(0, bytes.indexOf("\r\n"))).toString("latin1");
  if (!firstLine.startsWith("--") || firstLine.length < 3) {
    throw new UploadFormError(`${file} is not the multipart upload wrangler writes`);
  }
  const form = await new Response(bytes, {
    headers: { "content-type": `multipart/form-data; boundary=${firstLine.slice(2)}` },
  }).formData();
  const metadataPart = form.get("metadata");
  if (typeof metadataPart !== "string") {
    throw new UploadFormError(`${file} holds no upload metadata`);
  }
  const metadata = JSON.parse(metadataPart) as { main_module?: unknown; body_part?: unknown };
  if (metadata.body_part !== undefined) {
    throw new UploadFormError(
      "the Worker is written in the service-worker format (addEventListener), which wrangler " +
        "uploads as a script with its other modules as bindings; Appflare installs ES module " +
        "Workers (export default { fetch }) only",
    );
  }
  const main = typeof metadata.main_module === "string" ? moduleName(metadata.main_module) : null;
  const modules: UploadModule[] = [];
  for (const [rawName, part] of form.entries()) {
    if (rawName === "metadata") continue;
    if (typeof part === "string") {
      throw new UploadFormError(`the upload's part ${rawName} is not a module file`);
    }
    const contentType = bareContentType(part.type);
    if (contentType === SOURCE_MAP_CONTENT_TYPE) continue;
    const type = MODULE_TYPE_BY_CONTENT_TYPE[contentType];
    if (type === undefined) {
      throw new UploadFormError(
        `wrangler uploads the module ${rawName} as ${JSON.stringify(part.type)}, ` +
          "which is not a module type the artifact knows",
      );
    }
    const name = moduleName(rawName);
    modules.push({
      name,
      type,
      bytes: Buffer.from(await part.arrayBuffer()),
      isMain: name === main,
    });
  }
  if (main === null) {
    if (modules.length > 0) {
      throw new UploadFormError("the upload has modules but names no main module");
    }
    return [];
  }
  const mainModule = modules.find((m) => m.isMain);
  if (mainModule === undefined) {
    throw new UploadFormError(`the upload names the main module ${main} but has no such part`);
  }
  const others = modules.filter((m) => !m.isMain).sort((a, b) => (a.name < b.name ? -1 : 1));
  return [mainModule, ...others];
}
