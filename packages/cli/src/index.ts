/**
 * `@appflare/cli` / `create-appflare`: installs the Appflare
 * manager into a Cloudflare account from a signed release artifact, and
 * reports on, rolls back, and uninstalls it; also adds and removes the
 * optional sandbox Worker. The bins are `dist/cli.js`; this
 * entry exposes the building blocks for tests and tooling.
 */

export { type Account, chooseAccount, parseWhoami } from "./account.ts";
export {
  artifactZipName,
  MANAGER_APP,
  SANDBOX_APP,
  safeJoin,
  type UnpackedArtifact,
  unpackArtifact,
  type VerifiedArtifact,
  verifyArtifact,
} from "./artifact.ts";
export { sandboxDisable, sandboxEnable } from "./commands/sandbox.ts";
export type { CommandContext } from "./context.ts";
export { parseDeployOutput } from "./deploy-output.ts";
export { main, splitCommand, USAGE } from "./main.ts";
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
  SANDBOX_RELEASES,
  selectReleaseAssets,
} from "./release.ts";
export {
  buildSandboxWranglerConfig,
  explainSandboxDeployFailure,
  hasSandboxBindings,
  SANDBOX_CONTAINERS,
  type SandboxWranglerConfig,
} from "./sandbox-config.ts";
export { formatSetupUrl, generateBetterAuthSecret, generateSetupToken } from "./secrets.ts";
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
