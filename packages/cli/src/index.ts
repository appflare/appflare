/**
 * `create-appflare`: installs the Appflare manager into a
 * Cloudflare account from a signed release artifact. The bin is `dist/cli.js`;
 * this entry exposes the building blocks for tests and tooling (the release
 * scripts verify and unpack manager artifacts with the same code).
 */

export { type Account, chooseAccount, parseWhoami } from "./account.ts";
export {
  artifactZipName,
  MANAGER_APP,
  safeJoin,
  type UnpackedArtifact,
  unpackArtifact,
  type VerifiedArtifact,
  verifyArtifact,
} from "./artifact.ts";
export type { CommandContext } from "./context.ts";
export { parseDeployOutput } from "./deploy-output.ts";
export { main, REMOVED_COMMANDS, USAGE, wantsVersion } from "./main.ts";
export { autoProvisionedResourceName, DEFAULT_WORKER_NAME, validateWorkerName } from "./names.ts";
export { checkNodeVersion, MIN_NODE_MAJOR } from "./node-version.ts";
export {
  findManagerRelease,
  findRelease,
  MANAGER_RELEASES,
  type ManagerReleaseAssets,
  pickLatestManagerRelease,
  type ReleaseAssets,
  type ReleaseChannel,
  releaseApiUrl,
  selectReleaseAssets,
} from "./release.ts";
export { formatManagerUrl, generateBetterAuthSecret } from "./secrets.ts";
export {
  createWrangler,
  resolveWranglerBin,
  type Spawner,
  type SpawnRequest,
  type SpawnResult,
  wranglerArgs,
  wranglerEnv,
} from "./wrangler.ts";
export {
  buildWranglerConfig,
  type GeneratedWranglerConfig,
  workflowNameFor,
} from "./wrangler-config.ts";
