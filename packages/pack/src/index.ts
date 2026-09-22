/**
 * `@appflare/pack` — the artifact packer. Turns a checkout of a
 * wrangler project plus a catalog manifest into a signed, uncompressed-zip
 * artifact, and verifies one.
 */

export { parseJsonc } from "./jsonc.ts";
export type { PackOptions, PackResult } from "./pack.ts";
export { pack } from "./pack.ts";
export type { VerifyOptions, VerifyResult } from "./verify.ts";
export { verify } from "./verify.ts";
export { deriveVersion, formatBuildDate, semverFromRef } from "./version.ts";
export {
  classifyModuleType,
  collectBindings,
  mainModuleName,
  type ResolvedWranglerConfig,
} from "./wrangler-config.ts";
export type { ZipEntryPlacement } from "./zip.ts";
export { crc32, ZipStore } from "./zip.ts";
