/**
 * `@appflare/pack` — the artifact packer. Turns a checkout of a
 * wrangler project plus a catalog manifest into an uncompressed-zip artifact,
 * signs it (in the same step or separately), and verifies one.
 */

/** The most Worker modules Appflare can upload; `verify --max-modules` takes it. */
export { MAX_WORKER_MODULES } from "@appflare/schema";
export { parseJsonc } from "./jsonc.ts";
export type { PackOptions, PackResult } from "./pack.ts";
export { describeVersionOrigin, pack, packWarnings } from "./pack.ts";
export type { SignOptions, SignResult } from "./sign.ts";
export { sign } from "./sign.ts";
export { UNSIGNED_KEY_ID } from "./signing.ts";
export type { VerifyOptions, VerifyResult } from "./verify.ts";
export { verify } from "./verify.ts";
export {
  type DeriveVersionInput,
  deriveVersion,
  deriveVersionWithOrigin,
  formatBuildDate,
  semverFromRef,
  type VersionOrigin,
} from "./version.ts";
export {
  classifyModuleType,
  collectBindings,
  mainModuleName,
  type ResolvedWranglerConfig,
} from "./wrangler-config.ts";
export type { ZipEntryPlacement } from "./zip.ts";
export { crc32, ZipStore } from "./zip.ts";
