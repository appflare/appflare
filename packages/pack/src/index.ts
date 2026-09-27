/**
 * `@appflare/pack` — the artifact packer. Turns a checkout of a
 * wrangler project plus a catalog manifest into an uncompressed-zip artifact,
 * signs it (in the same step or separately), and verifies one.
 */

/**
 * What one Appflare upload may carry and cost (`verify --check-upload` applies
 * it), and a new VAPID private key for a `generate: "vapid-private-key"` secret.
 */
export {
  generateVapidPrivateKey,
  MAX_WORKER_UPLOAD_BYTES,
  MAX_WORKER_UPLOAD_SUBREQUESTS,
  workerUploadCost,
  workerUploadProblem,
} from "@appflare/schema";
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
  type ApplyConfigPatchesOptions,
  applyConfigPatches,
  ConfigPatchError,
  readRawWranglerConfig,
  type WorkerSpec,
  workerSpecs,
} from "./config-patch.ts";
export {
  ConfigRedirectError,
  ConfigTemplateError,
  copyTemplateConfig,
  DEPLOY_CONFIG_PATH,
  resolveWranglerConfig,
  type WranglerConfigTarget,
} from "./config-redirect.ts";
export { deriveSecretValue } from "./derive-secret.ts";
export { type InspectOptions, inspectWranglerConfig, wranglerFacts } from "./inspect.ts";
export {
  BUNDLED_NPM_MAJOR,
  FALLBACK_NPM_MAJOR,
  findLockfile,
  InstallError,
  type InstallInvocation,
  type InstallOptions,
  type InstallRunner,
  type InstallRunResult,
  installDependencies,
  installInvocation,
  isNewerNpmLockfileFailure,
  lowestRangeMajor,
  NPM_11_SPEC,
  npmSpec,
  type PackageManagerFlavor,
  packageManagerFlavor,
  packageManagerMajor,
  resolveInstallDir,
} from "./install.ts";
export { parseJsonc } from "./jsonc.ts";
export type { PackedWorker, PackOptions, PackResult } from "./pack.ts";
export { describeVersionOrigin, mergeD1Migrations, pack } from "./pack.ts";
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
  type WorkerSize,
  workerSize,
  workerSizeLine,
} from "./worker-size.ts";
export {
  type CollectBindingsOptions,
  checkHyperdriveDeclarations,
  checkPipelineDeclarations,
  checkVectorizeDeclarations,
  classifyModuleType,
  collectBindings,
  collectQueueConsumers,
  HyperdriveDeclarationError,
  mainModuleName,
  PipelineDeclarationError,
  QueueConsumerError,
  queueProducerBindings,
  type ResolvedWranglerConfig,
  ServiceBindingError,
  UnsafeBindingError,
  unsafeRateLimits,
  VectorizeDeclarationError,
  type WranglerQueueConsumer,
  withoutSecretVars,
} from "./wrangler-config.ts";
export type { ZipEntryPlacement } from "./zip.ts";
export { crc32, ZipStore } from "./zip.ts";
