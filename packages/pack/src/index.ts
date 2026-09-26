/**
 * `@appflare/pack` — the artifact packer. Turns a checkout of a
 * wrangler project plus a catalog manifest into an uncompressed-zip artifact,
 * signs it (in the same step or separately), and verifies one.
 */

/** The most Worker modules Appflare can upload; `verify --max-modules` takes it. */
export { MAX_WORKER_MODULES } from "@appflare/schema";
export {
  BUILD_HOOKS_OFF_ENV,
  BuildCommandError,
  type BuildCommandOptions,
  type BuildCommandsOptions,
  DEFAULT_BUILD_TIMEOUT_MS,
  runBuildCommand,
  runBuildCommands,
} from "./build-command.ts";
export {
  ConfigRedirectError,
  ConfigTemplateError,
  copyTemplateConfig,
  DEPLOY_CONFIG_PATH,
  resolveWranglerConfig,
  type WranglerConfigTarget,
} from "./config-redirect.ts";
export { deriveSecretValue } from "./derive-secret.ts";
export { inspectWranglerConfig, wranglerFacts } from "./inspect.ts";
export { parseJsonc } from "./jsonc.ts";
export type { PackedWorker, PackOptions, PackResult } from "./pack.ts";
export { describeVersionOrigin, mergeD1Migrations, pack, packWarnings } from "./pack.ts";
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
  artifactWorkerSize,
  formatBytes,
  MAX_WORKER_SIZE_BYTES,
  type WorkerSize,
  workerSize,
  workerSizeLine,
  workerTooLargeMessage,
} from "./worker-size.ts";
export {
  type CollectBindingsOptions,
  checkHyperdriveDeclarations,
  checkVectorizeDeclarations,
  classifyModuleType,
  collectBindings,
  collectQueueConsumers,
  HyperdriveDeclarationError,
  mainModuleName,
  QueueConsumerError,
  queueProducerBindings,
  type ResolvedWranglerConfig,
  ServiceBindingError,
  VectorizeDeclarationError,
  type WranglerQueueConsumer,
} from "./wrangler-config.ts";
export type { ZipEntryPlacement } from "./zip.ts";
export { crc32, ZipStore } from "./zip.ts";
